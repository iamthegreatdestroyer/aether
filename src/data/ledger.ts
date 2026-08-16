/**
 * The verification ledger's write path — live from P0, by design.
 *
 * The ledger UI (*Who Was Right?*) is a P3 deliverable, but the proposal is explicit that the
 * logging must not wait for it: "P3's trust moat starts logging from first install even before
 * its UI ships, so the ledger is populated by the time the leaderboard lands" (§5.4.1). Every
 * forecast the app displays is already on the fetch path; writing it down costs one IndexedDB
 * add. The T+1 scorer against METAR/Sensor.Community observations arrives in P3 and will find
 * months of history waiting.
 *
 * Append-only. Nothing edits or deletes a log entry — a receipt that can be rewritten is not
 * a receipt.
 */

import { STORE_FORECAST_LOG, STORE_LATEST, dbAdd, dbCount, dbGet, dbPut } from './db';
import type { ForecastData } from './openmeteo';

export interface ForecastLogEntry {
  locationKey: string;
  name: string;
  lat: number;
  lon: number;
  /** Epoch ms at fetch time — the moment the receipt was taken. */
  fetchedAt: number;
  sourceId: 'open-meteo';
  model: string;
  /** Full 7-day hourly subset — what the T+1 scorer will diff against observations. */
  hourly: ForecastData['hourly'];
  daily: ForecastData['daily'];
}

export interface LatestSnapshot {
  fetchedAt: number;
  data: ForecastData;
}

/**
 * Guard against refresh spam: reloading the app five times in an hour should not write five
 * near-identical receipts. One entry per location per hour is ample for T+1 scoring, where
 * the comparison grid is hourly anyway.
 */
const MIN_LOG_INTERVAL_MS = 60 * 60 * 1000;
const lastLogKey = (locationKey: string) => `aether.lastlog.${locationKey}`;

export async function logForecast(entry: ForecastLogEntry): Promise<boolean> {
  const guard = lastLogKey(entry.locationKey);
  const last = Number(localStorage.getItem(guard) ?? 0);
  if (entry.fetchedAt - last < MIN_LOG_INTERVAL_MS) return false;
  await dbAdd(STORE_FORECAST_LOG, entry);
  localStorage.setItem(guard, String(entry.fetchedAt));
  return true;
}

/** The offline path: latest snapshot per location, overwritten on every successful fetch. */
export function saveLatest(locationKey: string, data: ForecastData): Promise<IDBValidKey> {
  const snap: LatestSnapshot = { fetchedAt: Date.now(), data };
  return dbPut(STORE_LATEST, snap, locationKey);
}

export function loadLatest(locationKey: string): Promise<LatestSnapshot | undefined> {
  return dbGet<LatestSnapshot>(STORE_LATEST, locationKey);
}

/** For the debug hook and, later, the ledger UI. */
export function ledgerCount(): Promise<number> {
  return dbCount(STORE_FORECAST_LOG);
}
