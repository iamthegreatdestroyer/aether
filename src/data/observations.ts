/**
 * Observations — the truth side of the verification ledger.
 *
 * A forecast receipt is worthless without something real to score it against, and the
 * proposal's first-choice obs source (aviationweather.gov METARs) sends no CORS header — a
 * Tauri-native upgrade, not a PWA option. What IS browser-reachable, verified live:
 *
 *   nws-obs           US: real station observations WITH HISTORY (points → stations →
 *                     /observations?start=…). Public domain, CORS *. Can backfill hours the
 *                     app was closed for.
 *   sensor-community  Global: citizen stations, CURRENT values only — so capture is
 *                     opportunistic: each refresh stores "now" as truth for this hour, and
 *                     only hours the app was open for become scorable. Median across
 *                     stations in a ~10 km box blunts individual bad sensors.
 *
 * Locations covered by neither say so, plainly. An unverifiable location marked
 * "unverifiable" is honest; one silently scored against a reanalysis would be theater.
 *
 * Captured obs land in the `obs` store keyed `${locationKey}|${isoHour}` — idempotent per
 * hour, so refresh spam cannot double-count truth.
 */

import { STORE_OBS, dbGetAllByIndex, dbPut } from './db';
import { fetchJson } from './fetcher';
import { source } from './sources.mjs';
import { locationKey } from '../ui/locations';
import type { SavedLocation } from '../ui/locations';

export interface Observation {
  locationKey: string;
  /** ISO hour (UTC, minutes zeroed) this observation stands for. */
  hour: string;
  /** Actual observation timestamp. */
  observedAt: string;
  temperatureC: number;
  windSpeedMs: number | null;
  provider: 'nws-obs' | 'sensor-community';
  /** Station id / sensor count — provenance for the receipts UI. */
  station: string;
}

function isoHour(d: Date): string {
  const h = new Date(d);
  h.setUTCMinutes(0, 0, 0);
  return h.toISOString().slice(0, 13) + ':00Z';
}

function obsKey(o: Pick<Observation, 'locationKey' | 'hour'>): string {
  return `${o.locationKey}|${o.hour}`;
}

// ------------------------------------------------------------------ NWS (US)

interface NwsStationCache {
  stationId: string;
  stationUrl: string;
}

const stationCacheKey = (lk: string) => `aether.nwsstation.${lk}`;

/** Resolve (and cache) the nearest NWS station for a location; null outside NWS coverage. */
async function nwsStation(loc: SavedLocation): Promise<NwsStationCache | null> {
  const lk = locationKey(loc);
  const cached = localStorage.getItem(stationCacheKey(lk));
  if (cached === 'none') return null;
  if (cached) return JSON.parse(cached) as NwsStationCache;

  const base = source('nws-points').baseUrl;
  try {
    const points = await fetchJson<{ properties: { observationStations: string } }>(
      'nws-points',
      `${base}/points/${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`,
    );
    const stations = await fetchJson<{
      features: Array<{ id: string; properties: { stationIdentifier: string } }>;
    }>('nws-points', points.properties.observationStations);
    const first = stations.features[0];
    if (!first) throw new Error('no stations');
    const entry: NwsStationCache = {
      stationId: first.properties.stationIdentifier,
      stationUrl: first.id,
    };
    localStorage.setItem(stationCacheKey(lk), JSON.stringify(entry));
    return entry;
  } catch {
    // Outside NWS coverage (or transient). Cache the miss for a day via a dated sentinel
    // would add state; 'none' is cleared manually if the user moves a pin. Keep simple.
    localStorage.setItem(stationCacheKey(lk), 'none');
    return null;
  }
}

/** Backfill NWS observations for the unscored window — works for hours the app slept through. */
async function captureNws(loc: SavedLocation, sinceIso: string): Promise<Observation[]> {
  const st = await nwsStation(loc);
  if (!st) return [];
  const lk = locationKey(loc);
  const data = await fetchJson<{
    features: Array<{
      properties: {
        timestamp: string;
        temperature: { value: number | null };
        windSpeed: { value: number | null };
      };
    }>;
  }>('nws-points', `${st.stationUrl}/observations?start=${encodeURIComponent(sinceIso)}`);

  // One observation per hour: the one closest to the top of the hour wins.
  const byHour = new Map<string, Observation>();
  for (const f of data.features) {
    const p = f.properties;
    if (p.temperature.value === null) continue;
    const hour = isoHour(new Date(p.timestamp));
    const candidate: Observation = {
      locationKey: lk,
      hour,
      observedAt: p.timestamp,
      temperatureC: p.temperature.value,
      windSpeedMs: p.windSpeed.value !== null ? p.windSpeed.value / 3.6 : null,
      provider: 'nws-obs',
      station: st.stationId,
    };
    const existing = byHour.get(hour);
    const dist = (o: Observation) =>
      Math.abs(new Date(o.observedAt).getTime() - new Date(o.hour).getTime());
    if (!existing || dist(candidate) < dist(existing)) byHour.set(hour, candidate);
  }
  return [...byHour.values()];
}

// ------------------------------------------------- Sensor.Community (global)

/** Current conditions from citizen stations in a ~±0.08° box; median temperature. */
async function captureSensorCommunity(loc: SavedLocation): Promise<Observation[]> {
  const base = source('sensor-community').baseUrl;
  const d = 0.08;
  const box = `${(loc.lat - d).toFixed(3)},${(loc.lon - d).toFixed(3)},${(loc.lat + d).toFixed(3)},${(loc.lon + d).toFixed(3)}`;
  const records = await fetchJson<
    Array<{ timestamp: string; sensordatavalues: Array<{ value_type: string; value: string }> }>
  >('sensor-community', `${base}/box=${box}`);

  const temps: number[] = [];
  for (const rec of records) {
    for (const v of rec.sensordatavalues) {
      if (v.value_type === 'temperature') {
        const t = Number(v.value);
        // Citizen sensors in direct sun read absurdly high; a coarse sanity band keeps
        // obvious garbage out while the median handles the rest.
        if (Number.isFinite(t) && t > -60 && t < 55) temps.push(t);
      }
    }
  }
  if (temps.length < 3) return []; // fewer than 3 stations is anecdote, not observation
  temps.sort((a, b) => a - b);
  const median = temps[Math.floor(temps.length / 2)]!;
  const now = new Date();
  return [
    {
      locationKey: locationKey(loc),
      hour: isoHour(now),
      observedAt: now.toISOString(),
      temperatureC: median,
      windSpeedMs: null,
      provider: 'sensor-community',
      station: `${temps.length} citizen stations (median)`,
    },
  ];
}

// ------------------------------------------------------------------- public

const obsWatermarkKey = (lk: string) => `aether.obswm.${lk}`;

/**
 * Capture whatever truth is available for a location and persist it. Returns what was
 * stored. NWS backfills since the last watermark (max 48 h); Sensor.Community contributes
 * the current hour only.
 */
export async function captureObservations(loc: SavedLocation): Promise<Observation[]> {
  const lk = locationKey(loc);
  const wmRaw = localStorage.getItem(obsWatermarkKey(lk));
  const floor = Date.now() - 48 * 3600 * 1000;
  const since = new Date(Math.max(wmRaw ? Date.parse(wmRaw) : 0, floor)).toISOString();

  let captured: Observation[] = [];
  try {
    captured = await captureNws(loc, since);
  } catch {
    /* fall through to Sensor.Community */
  }
  if (captured.length === 0) {
    try {
      captured = await captureSensorCommunity(loc);
    } catch {
      /* no truth available — recorded as such by returning [] */
    }
  }

  for (const o of captured) {
    await dbPut(STORE_OBS, o, obsKey(o));
  }
  if (captured.length > 0) {
    const newest = captured.reduce((a, b) => (a.observedAt > b.observedAt ? a : b));
    localStorage.setItem(obsWatermarkKey(lk), newest.observedAt);
  }
  return captured;
}

/** Which provider serves this location, for the receipts UI's provenance line. */
export function obsProviderLabel(lk: string): string {
  const cached = localStorage.getItem(stationCacheKey(lk));
  if (cached && cached !== 'none') {
    return `NWS station ${(JSON.parse(cached) as NwsStationCache).stationId}`;
  }
  if (cached === 'none') return 'Sensor.Community (opportunistic, app-open hours only)';
  return 'not yet determined';
}

export function loadObservations(lk: string): Promise<Observation[]> {
  return dbGetAllByIndex<Observation>(STORE_OBS, 'by_location', lk);
}
