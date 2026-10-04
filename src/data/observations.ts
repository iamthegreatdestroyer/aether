/**
 * Observations — the truth side of the verification ledger.
 *
 * A forecast receipt is worthless without something real to score it against. The chain,
 * in order:
 *
 *   nws-obs           US: real station observations WITH HISTORY (points → stations →
 *                     /observations?start=…). Public domain, CORS *. Can backfill hours the
 *                     app was closed for. Stays first for US locations so an established
 *                     ledger (KNYC for NYC) never silently switches truth source.
 *   metar             GLOBAL station history — aviationweather.gov, the proposal's
 *                     first-choice truth. No CORS header, so this is the contract's second
 *                     A-native cheque: it only runs under the desktop shell's Rust-side
 *                     transport (P6). One bbox query returns every nearby airport's reports
 *                     WITH their coordinates, so station resolution is a haversine over the
 *                     response — no station directory needed (verified 2026-08-18).
 *   sensor-community  Global PWA fallback: citizen stations, CURRENT values only — capture
 *                     is opportunistic: each refresh stores "now" as truth for this hour.
 *                     Median across stations in a ~10 km box blunts individual bad sensors.
 *
 * Locations covered by none of these say so, plainly. An unverifiable location marked
 * "unverifiable" is honest; one silently scored against a reanalysis would be theater.
 *
 * Captured obs land in the `obs` store keyed `${locationKey}|${isoHour}` — idempotent per
 * hour, so refresh spam cannot double-count truth.
 */

import { STORE_OBS, STORE_SCORES, dbClear, dbDelete, dbEntries, dbGetAllByIndex, dbPut } from './db';
import { fetchJson, hasNativeTransport } from './fetcher';
import { haversineKm } from './geo';
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
  provider: 'nws-obs' | 'metar' | 'sensor-community';
  /** Station id / sensor count — provenance for the receipts UI. */
  station: string;
}

/**
 * The forecast hour an observation belongs to: the NEAREST top of the hour, not the one before.
 * Airport routine reports are taken at :53 and are filed as the next hour's report (their
 * `reportTime` says so); flooring them scored a 23:53 observation against the 23:00 forecast
 * — 53 minutes of weather in the wrong direction. Measured 2026-10-03 at KTPA: 30 of 37 reports
 * at minute :53, mean hourly change 0.48 C, so about 0.4 C of phantom error on every scored
 * hour (and ~0.9 C where days swing harder). All models paid it equally, so rankings held, but
 * every absolute error and every "within 2 degrees" rate was worse than the truth.
 */
function isoHour(d: Date): string {
  const t = Math.round(d.getTime() / 3_600_000) * 3_600_000;
  return new Date(t).toISOString().slice(0, 13) + ':00Z';
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

// -------------------------------------------- METAR (global, desktop-native)

interface MetarReport {
  icaoId: string;
  lat: number;
  lon: number;
  temp: number | null;
  wspd: number | null; // knots
  obsTime: number | null; // epoch seconds
  reportTime: string | null;
}

const metarStationKey = (lk: string) => `aether.metarstation.${lk}`;

/**
 * METAR backfill — exported so the desktop self-check can cash the cheque end-to-end
 * without touching the obs store (this function only reads; persistence happens in
 * captureObservations). Verified live 2026-08-18: the London box returns EGLL/EGLC/EGWU/…
 * at 20-minute cadence with per-report coordinates; Tokyo returns the RJT* cluster.
 */
export async function captureMetar(loc: SavedLocation, sinceIso: string): Promise<Observation[]> {
  if (!hasNativeTransport()) return [];
  const lk = locationKey(loc);
  const hours = Math.min(48, Math.max(1, Math.ceil((Date.now() - Date.parse(sinceIso)) / 3_600_000)));
  const d = 0.7; // ~50-78 km box — wide enough for the nearest airports, not a region dump
  const base = source('aviationweather').baseUrl;
  const u =
    `${base}/metar?bbox=${(loc.lat - d).toFixed(2)},${(loc.lon - d).toFixed(2)},` +
    `${(loc.lat + d).toFixed(2)},${(loc.lon + d).toFixed(2)}&format=json&hours=${hours}`;
  const reports = await fetchJson<MetarReport[]>('aviationweather', u);

  // Nearest station that actually reports temperature wins; its history is the series.
  let bestId: string | null = null;
  let bestKm = Infinity;
  for (const r of reports) {
    if (typeof r.temp !== 'number') continue;
    const km = haversineKm(loc.lat, loc.lon, r.lat, r.lon);
    if (km < bestKm) {
      bestKm = km;
      bestId = r.icaoId;
    }
  }
  if (!bestId) return [];
  localStorage.setItem(
    metarStationKey(lk),
    JSON.stringify({ stationId: bestId, distanceKm: Math.round(bestKm) }),
  );

  // One observation per hour, closest to the top of the hour — same rule as NWS.
  const byHour = new Map<string, Observation>();
  for (const r of reports) {
    if (r.icaoId !== bestId || typeof r.temp !== 'number') continue;
    const t =
      r.obsTime !== null ? new Date(r.obsTime * 1000) : r.reportTime ? new Date(r.reportTime) : null;
    if (!t || Number.isNaN(t.getTime())) continue;
    const candidate: Observation = {
      locationKey: lk,
      hour: isoHour(t),
      observedAt: t.toISOString(),
      temperatureC: r.temp,
      windSpeedMs: typeof r.wspd === 'number' ? Math.round(r.wspd * 51.4444) / 100 : null,
      provider: 'metar',
      station: `${bestId} · ${Math.round(bestKm)} km`,
    };
    const existing = byHour.get(candidate.hour);
    const dist = (o: Observation) =>
      Math.abs(new Date(o.observedAt).getTime() - new Date(o.hour).getTime());
    if (!existing || dist(candidate) < dist(existing)) byHour.set(candidate.hour, candidate);
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

// ------------------------------------------------------------------- migration

const REBUCKET_FLAG = 'aether.obsbucket.v2';

/**
 * One-time repair of observations stored under the old floor-to-hour rule. The observation's
 * own `observedAt` is authoritative, so each is re-filed under its nearest hour; where two land
 * on one hour the one closer to the top of the hour wins. Scores are DERIVED data (keyed
 * deterministically, rebuilt from the append-only forecast log), so they are cleared and the
 * normal scorer rebuilds them — nothing irreplaceable is touched. New keys are written before
 * old ones are removed, and the flag is set last, so an interruption just repeats the repair.
 */
export async function rebucketObservations(): Promise<{ moved: number }> {
  if (localStorage.getItem(REBUCKET_FLAG)) return { moved: 0 };
  const all = await dbEntries<Observation>(STORE_OBS);
  const winners = new Map<string, Observation>();
  const dist = (o: Observation) => Math.abs(Date.parse(o.observedAt) - Date.parse(o.hour));
  for (const { value } of all) {
    const t = new Date(value.observedAt);
    if (Number.isNaN(t.getTime())) continue;
    const fixed: Observation = { ...value, hour: isoHour(t) };
    const k = obsKey(fixed);
    const prev = winners.get(k);
    if (!prev || dist(fixed) < dist(prev)) winners.set(k, fixed);
  }
  for (const [k, o] of winners) await dbPut(STORE_OBS, o, k);
  let moved = 0;
  for (const { key } of all) {
    if (!winners.has(String(key))) {
      await dbDelete(STORE_OBS, key);
      moved++;
    }
  }
  if (moved > 0) await dbClear(STORE_SCORES);
  localStorage.setItem(REBUCKET_FLAG, new Date().toISOString());
  return { moved };
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
    /* fall through */
  }
  if (captured.length === 0) {
    try {
      captured = await captureMetar(loc, since); // no-op in the PWA (native-only)
    } catch {
      /* fall through */
    }
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
  const metar = localStorage.getItem(metarStationKey(lk));
  if (metar) {
    const m = JSON.parse(metar) as { stationId: string; distanceKm: number };
    return `METAR ${m.stationId} · ${m.distanceKm} km (aviation-grade, via the desktop app)`;
  }
  if (cached === 'none') return 'Sensor.Community (opportunistic, app-open hours only)';
  return 'not yet determined';
}

export function loadObservations(lk: string): Promise<Observation[]> {
  return dbGetAllByIndex<Observation>(STORE_OBS, 'by_location', lk);
}
