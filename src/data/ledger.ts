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
import { fetchJson } from './fetcher';
import { source } from './sources.mjs';
import type { ForecastData } from './openmeteo';
import type { SavedLocation } from '../ui/locations';

/** One model's 7-day hourly grid, times in UTC to match the obs store. */
export interface ModelSeries {
  time: string[];
  temperature_2m: Array<number | null>;
  wind_speed_10m: Array<number | null>;
  precipitation: Array<number | null>;
}

export interface ForecastLogEntry {
  locationKey: string;
  name: string;
  lat: number;
  lon: number;
  /** Epoch ms at fetch time — the moment the receipt was taken. */
  fetchedAt: number;
  sourceId: 'open-meteo';
  /**
   * v2 entries: per-model grids so *Who Was Right?* can rank ECMWF vs GFS vs ICON vs the
   * best_match blend the app actually displays. v1 (P0-era) entries instead carry `hourly`
   * (best_match only) — the scorer reads both; the append-only log is never migrated.
   */
  models?: Record<string, ModelSeries>;
  model?: string;
  hourly?: ForecastData['hourly'];
  daily?: ForecastData['daily'];
}

/** Models ranked by the ledger. best_match is included because it IS what the app shows —
 *  "did the blend beat its own ingredients at your location" is the most useful row. */
export const LEDGER_MODELS = ['best_match', 'ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'];

export const MODEL_LABELS: Record<string, string> = {
  best_match: 'Best match (blend)',
  ecmwf_ifs025: 'ECMWF IFS 0.25°',
  gfs_seamless: 'NOAA GFS',
  icon_seamless: 'DWD ICON',
};

/**
 * The ledger's own fetch: hourly-only, four models, UTC. Separate from the display fetch on
 * purpose — the card's parsing stays P0-stable, and this runs at most once per hour per
 * location behind the same guard that gates logging.
 */
export async function fetchLedgerForecast(
  loc: SavedLocation,
): Promise<Record<string, ModelSeries>> {
  const om = source('open-meteo');
  if (!om.baseUrl) throw new Error('open-meteo contract entry has no baseUrl');
  const u = new URL(om.baseUrl);
  u.searchParams.set('latitude', loc.lat.toFixed(4));
  u.searchParams.set('longitude', loc.lon.toFixed(4));
  u.searchParams.set('hourly', 'temperature_2m,wind_speed_10m,precipitation');
  u.searchParams.set('models', LEDGER_MODELS.join(','));
  u.searchParams.set('timezone', 'UTC');
  u.searchParams.set('wind_speed_unit', 'ms');
  u.searchParams.set('forecast_days', '7');

  const raw = await fetchJson<{ hourly: Record<string, unknown> }>('open-meteo', u.toString());
  const time = raw.hourly['time'] as string[];
  const out: Record<string, ModelSeries> = {};
  for (const m of LEDGER_MODELS) {
    out[m] = {
      time,
      temperature_2m: (raw.hourly[`temperature_2m_${m}`] ?? []) as Array<number | null>,
      wind_speed_10m: (raw.hourly[`wind_speed_10m_${m}`] ?? []) as Array<number | null>,
      precipitation: (raw.hourly[`precipitation_${m}`] ?? []) as Array<number | null>,
    };
  }
  return out;
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

/** Exposed so the caller can skip the multi-model fetch entirely when logging is gated. */
export function shouldLog(locationKey: string, now = Date.now()): boolean {
  return now - Number(localStorage.getItem(lastLogKey(locationKey)) ?? 0) >= MIN_LOG_INTERVAL_MS;
}

export async function logForecast(entry: ForecastLogEntry): Promise<boolean> {
  const guard = lastLogKey(entry.locationKey);
  if (!shouldLog(entry.locationKey, entry.fetchedAt)) return false;
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
