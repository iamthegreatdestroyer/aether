/**
 * Space weather clients — the Solar Chain's data floor.
 *
 * Payload discipline is the design here, learned from the endpoint probe (ACTION_PLAN §0.3):
 * the live values come from SWPC's summary endpoints at 59 and 60 BYTES, polled only while
 * the panel is open; the OVATION aurora grid is 920 KB and is fetched ON DEMAND when the
 * panel opens, cached for its ~5-minute forecast window, and never polled. The 2.7 MB
 * 1-minute history endpoints exist in the contract for a future sparkline and are not
 * touched here.
 *
 * Kp honesty: NOAA's planetary K is an ESTIMATE — the official Kp producer is GFZ Potsdam,
 * whose endpoint sends no CORS header (contract: gfz-kp, Tauri-native upgrade). The UI is
 * required by the contract note to label it as an estimate, and does.
 */

import { STORE_LATEST, dbGet, dbPut } from './db';
import { fetchJson, fetchText, hasNativeTransport } from './fetcher';
import { source } from './sources.mjs';
import { azWord, computePasses } from './passes';
import type { Pass } from './passes';
import type { SavedLocation } from '../ui/locations';

export interface KpReading {
  time: string;
  kp: number;
}

/** NOAA G-scale: Kp 5=G1 minor … 9=G5 extreme. */
export function kpSeverity(kp: number): { level: string; cls: string } {
  if (kp >= 8) return { level: 'G4–G5 severe storm', cls: 'kp-extreme' };
  if (kp >= 7) return { level: 'G3 strong storm', cls: 'kp-strong' };
  if (kp >= 6) return { level: 'G2 moderate storm', cls: 'kp-moderate' };
  if (kp >= 5) return { level: 'G1 minor storm', cls: 'kp-minor' };
  if (kp >= 4) return { level: 'active', cls: 'kp-active' };
  return { level: 'quiet', cls: 'kp-quiet' };
}

export interface KpSeries {
  readings: KpReading[];
  /** Which producer answered — drives the honesty label in the panel. */
  sourceLabel: string;
  official: boolean;
}

/**
 * Last 3 days of 3-hourly Kp. Under the desktop shell the native transport reaches GFZ
 * Potsdam — the OFFICIAL Kp producer, whose endpoint sends no CORS header — and the panel's
 * long-standing "NOAA estimate" caveat resolves itself. The PWA keeps the estimate, labelled
 * as such; failure of either path falls through honestly.
 */
export async function fetchKpSeries(): Promise<KpSeries> {
  if (hasNativeTransport()) {
    try {
      const g = source('gfz-kp');
      const end = new Date();
      const start = new Date(end.getTime() - 3 * 24 * 3600 * 1000);
      const u = new URL(g.baseUrl ?? 'https://kp.gfz.de/app/json/');
      u.searchParams.set('start', start.toISOString().slice(0, 19) + 'Z');
      u.searchParams.set('end', end.toISOString().slice(0, 19) + 'Z');
      u.searchParams.set('index', 'Kp');
      const d = await fetchJson<{ datetime: string[]; Kp: number[] }>('gfz-kp', u.toString());
      const readings = d.datetime
        .map((t, i) => ({ time: t, kp: d.Kp[i]! }))
        .filter((r) => r.kp !== null)
        .slice(-24);
      if (readings.length > 0) {
        return { readings, sourceLabel: 'GFZ Potsdam — official Kp (CC BY 4.0)', official: true };
      }
    } catch {
      /* fall through to the estimate */
    }
  }
  const s = source('swpc-kp-estimate');
  const rows = await fetchJson<Array<{ time_tag: string; Kp: number }>>(
    'swpc-kp-estimate',
    s.baseUrl!,
  );
  return {
    readings: rows.slice(-24).map((r) => ({ time: r.time_tag, kp: r.Kp })),
    sourceLabel: 'NOAA estimate · official Kp: GFZ Potsdam',
    official: false,
  };
}

export interface SolarWindNow {
  speedKms: number;
  bt: number;
  bz: number;
  time: string;
}

/** The two 60-byte summaries — the polling-loop-safe live values. */
export async function fetchSolarWindNow(): Promise<SolarWindNow> {
  const [wind, mag] = await Promise.all([
    fetchJson<Array<{ proton_speed: number; time_tag: string }>>(
      'swpc-wind-summary',
      source('swpc-wind-summary').baseUrl!,
    ),
    fetchJson<Array<{ bt: number; bz_gsm: number; time_tag: string }>>(
      'swpc-mag-summary',
      source('swpc-mag-summary').baseUrl!,
    ),
  ]);
  const w = wind[0];
  const m = mag[0];
  if (!w || !m) throw new Error('SWPC summaries returned empty arrays');
  return { speedKms: w.proton_speed, bt: m.bt, bz: m.bz_gsm, time: w.time_tag };
}

// ------------------------------------------------- station passes (CelesTrak)

/** The two crewed stations — the rest of the group is modules, cargo and debris. */
const STATIONS = [
  { match: 'ISS (ZARYA)', label: 'ISS' },
  { match: 'CSS (TIANHE)', label: 'Tiangong' },
] as const;

const TLE_TTL_MS = 6 * 60 * 60 * 1000; // CelesTrak's polling floor is a HARD 2 h; stay far above it
const PASS_WINDOW_H = 48;

interface TleCache {
  fetchedAt: number;
  text: string;
}

async function stationTles(): Promise<Map<string, [string, string]>> {
  const cached = await dbGet<TleCache>(STORE_LATEST, 'tle:stations');
  let text: string;
  if (cached && Date.now() - cached.fetchedAt < TLE_TTL_MS) {
    text = cached.text;
  } else {
    text = await fetchText('celestrak', source('celestrak').baseUrl!);
    await dbPut(STORE_LATEST, { fetchedAt: Date.now(), text } satisfies TleCache, 'tle:stations');
  }
  const lines = text.split('\n').map((l) => l.trimEnd());
  const out = new Map<string, [string, string]>();
  for (let i = 0; i + 2 < lines.length + 1; i++) {
    const name = lines[i]?.trim();
    for (const st of STATIONS) {
      if (name === st.match && lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
        out.set(st.label, [lines[i + 1]!, lines[i + 2]!]);
      }
    }
  }
  return out;
}

export interface StationPass {
  station: string;
  pass: Pass;
  /** Cloud cover forecast at peak time; null when the forecast does not reach it. */
  cloudPct: number | null;
  verdict: { verdict: string; cls: string };
}

/** Cloud cover by UTC hour for the pass window — one small call per location. */
async function cloudByHour(loc: SavedLocation): Promise<Map<string, number>> {
  const om = source('open-meteo');
  const u = new URL(om.baseUrl!);
  u.searchParams.set('latitude', loc.lat.toFixed(3));
  u.searchParams.set('longitude', loc.lon.toFixed(3));
  u.searchParams.set('hourly', 'cloud_cover');
  u.searchParams.set('forecast_days', '3');
  u.searchParams.set('timezone', 'UTC');
  const d = await fetchJson<{ hourly: { time: string[]; cloud_cover: number[] } }>(
    'open-meteo',
    u.toString(),
  );
  const map = new Map<string, number>();
  d.hourly.time.forEach((t, i) => map.set(t.slice(0, 13), d.hourly.cloud_cover[i]!));
  return map;
}

function passVerdict(cloudPct: number | null): { verdict: string; cls: string } {
  if (cloudPct === null) return { verdict: 'cloud forecast unavailable', cls: 'aurora-maybe' };
  if (cloudPct <= 40) return { verdict: 'go look', cls: 'aurora-go' };
  if (cloudPct <= 80) return { verdict: 'sky permitting', cls: 'aurora-maybe' };
  return { verdict: 'overcast — pass hidden', cls: 'aurora-clouded' };
}

/**
 * Next VISIBLE pass of each station over a location within 48 h, crossed with the cloud
 * forecast at peak — the aurora × cloud pattern applied to spacecraft. "No visible pass"
 * is a real answer: most passes happen in daylight or with the station in shadow.
 */
export async function nextVisiblePasses(loc: SavedLocation): Promise<StationPass[]> {
  const [tles, clouds] = await Promise.all([
    stationTles(),
    cloudByHour(loc).catch(() => new Map<string, number>()),
  ]);
  const out: StationPass[] = [];
  for (const [label, [l1, l2]] of tles) {
    const passes = computePasses(l1, l2, loc.lat, loc.lon, Date.now(), PASS_WINDOW_H);
    const vis = passes.find((p) => p.visible);
    if (!vis) continue;
    const cloudPct =
      clouds.get(new Date(vis.maxElevMs).toISOString().slice(0, 13)) ?? null;
    out.push({ station: label, pass: vis, cloudPct, verdict: passVerdict(cloudPct) });
  }
  return out;
}

export { azWord };

// ------------------------------------------------------------ CME watch (DONKI)

export interface CmeOutlook {
  /** estimatedShockArrivalTime of the freshest Earth-directed Enlil run; null = quiet. */
  arrival: string | null;
  /** min–max across the run's kp_18/90/135/180 clock-angle estimates. */
  kpRange: [number, number] | null;
  /** modelCompletionTime of the run the prediction came from — provenance for the panel. */
  simIssued: string | null;
  /** How many Earth-directed runs the window held (context for "quiet"). */
  earthDirected: number;
  windowDays: number;
}

interface EnlilSim {
  modelCompletionTime: string | null;
  isEarthGB: boolean;
  estimatedShockArrivalTime: string | null;
  kp_18: number | null;
  kp_90: number | null;
  kp_135: number | null;
  kp_180: number | null;
}

interface CmeCache {
  fetchedAt: number;
  outlook: CmeOutlook;
}

const CME_TTL_MS = 3 * 60 * 60 * 1000; // DEMO_KEY is 10 req/h per IP — cache hard
const CME_WINDOW_DAYS = 7;

/**
 * CME watch — WSA-Enlil simulations from NASA DONKI, panel-open only, 3 h cache. The
 * DEMO_KEY quota (measured: 10/h per IP) makes the cache a requirement, not an optimisation.
 * "Quiet" (no Earth-directed run in the window) is a real answer and renders as one;
 * a thrown fetch error is a different answer and renders as "unavailable".
 */
const CME_FAIL_TTL_MS = 10 * 60 * 1000;
let cmeFailedAt = 0;

export async function fetchCmeOutlook(): Promise<CmeOutlook> {
  const cached = await dbGet<CmeCache>(STORE_LATEST, 'cme1');
  if (cached && Date.now() - cached.fetchedAt < CME_TTL_MS) return cached.outlook;
  // Negative cache: a DONKI quota 429 lasts the hour — without this, EVERY panel open
  // burns the scheduler's full 21 s backoff before rendering "unavailable" (felt live
  // 2026-08-18 when the probe runs exhausted the local IP's quota mid-verification).
  if (Date.now() - cmeFailedAt < CME_FAIL_TTL_MS) throw new Error('DONKI recently unavailable');

  const s = source('donki');
  const end = new Date();
  const start = new Date(end.getTime() - CME_WINDOW_DAYS * 24 * 3600 * 1000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  let sims: EnlilSim[];
  try {
    sims = await fetchJson<EnlilSim[]>(
      'donki',
      `${s.baseUrl}/WSAEnlilSimulations?startDate=${day(start)}&endDate=${day(end)}&api_key=DEMO_KEY`,
    );
  } catch (err) {
    cmeFailedAt = Date.now();
    throw err;
  }

  const earthDirected = sims.filter((x) => x.isEarthGB && x.estimatedShockArrivalTime);
  // Freshest run whose predicted arrival is still ahead (or within the last 12 h — "may be
  // arriving now" is worth showing; a week-old passed arrival is not).
  const live = earthDirected
    .filter((x) => Date.parse(x.estimatedShockArrivalTime!) > Date.now() - 12 * 3600 * 1000)
    .sort((a, b) => (a.modelCompletionTime ?? '').localeCompare(b.modelCompletionTime ?? ''))
    .pop();

  let outlook: CmeOutlook;
  if (live) {
    const kps = [live.kp_18, live.kp_90, live.kp_135, live.kp_180]
      .map(Number)
      .filter(Number.isFinite);
    outlook = {
      arrival: live.estimatedShockArrivalTime,
      kpRange: kps.length > 0 ? [Math.min(...kps), Math.max(...kps)] : null,
      simIssued: live.modelCompletionTime,
      earthDirected: earthDirected.length,
      windowDays: CME_WINDOW_DAYS,
    };
  } else {
    outlook = {
      arrival: null,
      kpRange: null,
      simIssued: null,
      earthDirected: earthDirected.length,
      windowDays: CME_WINDOW_DAYS,
    };
  }
  await dbPut(STORE_LATEST, { fetchedAt: Date.now(), outlook } satisfies CmeCache, 'cme1');
  return outlook;
}

interface OvationCache {
  forecastTime: string;
  /** aurora probability by [lonE][latIdx], reshaped from the 65,160-point list. */
  grid: Uint8Array;
  fetchedAt: number;
}

let ovation: OvationCache | null = null;
const OVATION_TTL_MS = 10 * 60 * 1000;

/**
 * OVATION grid, cached. Index math verified against live samples before this was written:
 * coordinates[i] = [lonE, lat, aurora] with i = lonE * 181 + (lat + 90).
 */
export async function fetchOvation(): Promise<{ forecastTime: string }> {
  if (ovation && Date.now() - ovation.fetchedAt < OVATION_TTL_MS) {
    return { forecastTime: ovation.forecastTime };
  }
  const s = source('ovation-aurora');
  const d = await fetchJson<{
    'Forecast Time': string;
    coordinates: Array<[number, number, number]>;
  }>('ovation-aurora', s.baseUrl!);
  const grid = new Uint8Array(360 * 181);
  for (const [lonE, lat, aurora] of d.coordinates) {
    grid[lonE * 181 + (lat + 90)] = aurora;
  }
  ovation = { forecastTime: d['Forecast Time'], grid, fetchedAt: Date.now() };
  return { forecastTime: ovation.forecastTime };
}

/** Aurora probability (0–100) at a point; requires fetchOvation() first. */
export function sampleAurora(lat: number, lon: number): number | null {
  if (!ovation) return null;
  const lonE = ((Math.round(lon) % 360) + 360) % 360;
  const latIdx = Math.max(0, Math.min(180, Math.round(lat) + 90));
  return ovation.grid[lonE * 181 + latIdx] ?? null;
}

/**
 * The verified-novel cross (proposal §4.1.1): aurora probability × cloud cover → can you
 * actually SEE it. Both halves shown; the verdict never hides either.
 */
export function auroraVerdict(
  auroraPct: number,
  cloudPct: number,
): { verdict: string; cls: string } {
  if (auroraPct < 5) return { verdict: 'no aurora expected at this latitude', cls: 'aurora-none' };
  if (cloudPct > 80) return { verdict: 'aurora likely overhead — but overcast', cls: 'aurora-clouded' };
  if (auroraPct >= 30 && cloudPct <= 40) return { verdict: 'go outside', cls: 'aurora-go' };
  if (auroraPct >= 10) return { verdict: 'possible low on the horizon — sky permitting', cls: 'aurora-maybe' };
  return { verdict: 'faint chance', cls: 'aurora-maybe' };
}
