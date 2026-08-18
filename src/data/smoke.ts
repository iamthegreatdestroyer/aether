/**
 * The Smoke Story (proposal §4.1.3) — composed ENTIRELY from lanes the app already ships:
 *
 *   fires   FIRMS VIIRS clusters via the Tier B cron (FIRMS sends no CORS header — measured
 *           — so the browser reads our same-origin thinned GeoJSON, stamped with its age).
 *   wind    the surface wind texture the particle layer already uses: sample it AT each
 *           fire and ray-test whether the wind there points toward the location.
 *   PM2.5   Sensor.Community citizen stations — the measured ground truth that keeps the
 *           ray test honest.
 *
 * The verdict is deliberately labelled a surface-wind ray test, not a plume model: no
 * HYSPLIT pretensions. Wind aloft differs, terrain channels smoke, inversions trap it.
 * The test answers one question honestly: "is anything upwind of me burning?"
 */

import { fetchJson, fetchText } from './fetcher';
import { source } from './sources.mjs';
import { bearingDeg, haversineKm } from './geo';
import { locationKey } from '../ui/locations';
import type { SavedLocation } from '../ui/locations';

export interface FireCluster {
  lat: number;
  lon: number;
  n: number;
  frp: number;
}

export interface FireData {
  clusters: FireCluster[];
  builtAt: string;
  source: string;
  detections: number;
}

interface FireGeoJson {
  features: Array<{ geometry: { coordinates: [number, number] }; properties: { n: number; frp: number } }>;
  builtAt: string;
  source: string;
  detections: number;
}

// ------------------------------------------------- live queries (MAP_KEY)

/**
 * The MAP_KEY is personal and free (email form at firms.modaps.eosdis.nasa.gov/api/map_key)
 * and lives in localStorage ONLY — never in source, never committed. Measured 2026-08-18:
 * the keyed API's SUCCESS responses send CORS *, so this upgrade works in the plain PWA;
 * responses carry 2.0URT rows (~1-2 h old) — fresher than the cron's 24 h window by hours.
 */
const FIRMS_KEY = 'aether.firmskey';

export function getFirmsKey(): string | null {
  const k = localStorage.getItem(FIRMS_KEY);
  return k && k.trim().length >= 16 ? k.trim() : null;
}

export function setFirmsKey(key: string | null): void {
  if (key === null) localStorage.removeItem(FIRMS_KEY);
  else localStorage.setItem(FIRMS_KEY, key.trim());
}

/** Three polar orbiters = three chances per day a pass caught the fire recently. */
const LIVE_SATS = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'];

export interface LiveCluster extends FireCluster {
  /** Newest detection in the cluster, epoch ms. */
  acqMs: number;
}

function parseAreaCsv(text: string): Array<{ lat: number; lon: number; frp: number; acqMs: number }> {
  const lines = text.trim().split('\n');
  const header = lines[0]?.split(',') ?? [];
  const col = (n: string) => header.indexOf(n);
  const iLat = col('latitude');
  const iLon = col('longitude');
  const iFrp = col('frp');
  const iDate = col('acq_date');
  const iTime = col('acq_time');
  const iConf = col('confidence');
  if (iLat < 0 || iLon < 0 || iDate < 0) return [];
  const out: Array<{ lat: number; lon: number; frp: number; acqMs: number }> = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i]!.split(',');
    if (c[iConf] === 'l') continue; // low-confidence VIIRS pixels are mostly noise
    const lat = Number(c[iLat]);
    const lon = Number(c[iLon]);
    const frp = Number(c[iFrp] ?? 0);
    const hhmm = (c[iTime] ?? '0').padStart(4, '0');
    const acqMs = Date.parse(`${c[iDate]}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(acqMs)) continue;
    out.push({ lat, lon, frp: Number.isFinite(frp) ? frp : 0, acqMs });
  }
  return out;
}

/**
 * Live detections in a bbox, clustered to ~5 km bins. Null without a key. Shared by the
 * per-location assessment (±4° box) and the map layer's viewport queries.
 */
export async function fetchLiveFiresBbox(
  west: number,
  south: number,
  east: number,
  north: number,
): Promise<{ clusters: LiveCluster[]; newestMs: number } | null> {
  const key = getFirmsKey();
  if (!key) return null;
  const s = source('firms-api');
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const area = `${clamp(west, -180, 180).toFixed(1)},${clamp(south, -90, 90).toFixed(1)},${clamp(east, -180, 180).toFixed(1)},${clamp(north, -90, 90).toFixed(1)}`;
  const texts = await Promise.all(
    LIVE_SATS.map((sat) =>
      fetchText('firms-api', `${s.baseUrl}/${key}/${sat}/${area}/1`).catch(() => ''),
    ),
  );
  if (texts.every((t) => t === '')) throw new Error('all live FIRMS queries failed');

  const BIN = 0.05;
  const bins = new Map<string, { n: number; frp: number; acqMs: number; lat: number; lon: number }>();
  for (const t of texts) {
    for (const det of parseAreaCsv(t)) {
      const k = `${Math.round(det.lat / BIN)}:${Math.round(det.lon / BIN)}`;
      const b = bins.get(k);
      if (b) {
        b.n += 1;
        b.frp += det.frp;
        b.acqMs = Math.max(b.acqMs, det.acqMs);
      } else {
        bins.set(k, { n: 1, frp: det.frp, acqMs: det.acqMs, lat: det.lat, lon: det.lon });
      }
    }
  }
  let newestMs = 0;
  const clusters: LiveCluster[] = [];
  for (const b of bins.values()) {
    newestMs = Math.max(newestMs, b.acqMs);
    clusters.push({ lat: b.lat, lon: b.lon, n: b.n, frp: Math.round(b.frp * 10) / 10, acqMs: b.acqMs });
  }
  return { clusters, newestMs };
}

/** The assessment's shape: a ±4° box around the location covers the 400 km radius. */
function fetchLiveFires(
  loc: SavedLocation,
): Promise<{ clusters: LiveCluster[]; newestMs: number } | null> {
  const d = 4;
  return fetchLiveFiresBbox(loc.lon - d, loc.lat - d, loc.lon + d, loc.lat + d);
}

let fireCache: FireData | null = null;

export async function loadFires(): Promise<FireData> {
  if (fireCache) return fireCache;
  const r = await fetch('data/fires/latest.json');
  if (!r.ok) throw new Error('fire clusters not built yet — the 6-hourly cron fills them in');
  const g = (await r.json()) as FireGeoJson;
  fireCache = {
    clusters: g.features.map((f) => ({
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      n: f.properties.n,
      frp: f.properties.frp,
    })),
    builtAt: g.builtAt,
    source: g.source,
    detections: g.detections,
  };
  return fireCache;
}

// ------------------------------------------------- surface wind sampler (CPU)

/** Minimal standalone sampler over the SAME artifacts the particle engine renders. */
interface WindGrid {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  validTime: string;
}

let windGrid: WindGrid | null = null;

async function loadWindGrid(): Promise<WindGrid> {
  if (windGrid) return windGrid;
  const meta = await fetch('data/wind/latest.json').then((r) => {
    if (!r.ok) throw new Error('wind sidecar missing');
    return r.json() as Promise<{ width: number; height: number; uMin: number; uMax: number; vMin: number; vMax: number; validTime: string }>;
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('wind texture missing'));
    i.src = 'data/wind/latest.png';
  });
  const c = document.createElement('canvas');
  c.width = meta.width;
  c.height = meta.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  windGrid = { pixels: ctx.getImageData(0, 0, meta.width, meta.height).data, ...meta };
  return windGrid;
}

/** u/v (m/s) at a point — nearest texel; the grid is ~1°, bilinear would be theater. */
function sampleUv(g: WindGrid, lat: number, lon: number): { u: number; v: number } {
  const x = Math.min(g.width - 1, Math.max(0, Math.round(((lon + 180) / 360) * (g.width - 1))));
  const y = Math.min(g.height - 1, Math.max(0, Math.round(((90 - lat) / 180) * (g.height - 1))));
  const i = (y * g.width + x) * 4;
  const u = (g.pixels[i]! / 255) * (g.uMax - g.uMin) + g.uMin;
  const v = (g.pixels[i + 1]! / 255) * (g.vMax - g.vMin) + g.vMin;
  return { u, v };
}

// ------------------------------------------------------------- PM2.5 truth

/** Median PM2.5 (µg/m³) from citizen stations in a ~10 km box; null under 3 stations. */
export async function fetchPm25(
  loc: SavedLocation,
): Promise<{ pm25: number; stations: number } | null> {
  const base = source('sensor-community').baseUrl;
  const d = 0.08;
  const box = `${(loc.lat - d).toFixed(3)},${(loc.lon - d).toFixed(3)},${(loc.lat + d).toFixed(3)},${(loc.lon + d).toFixed(3)}`;
  const records = await fetchJson<
    Array<{ sensordatavalues: Array<{ value_type: string; value: string }> }>
  >('sensor-community', `${base}/box=${box}`);
  const vals: number[] = [];
  for (const rec of records) {
    for (const v of rec.sensordatavalues) {
      if (v.value_type === 'P2') {
        const x = Number(v.value);
        if (Number.isFinite(x) && x >= 0 && x < 1000) vals.push(x);
      }
    }
  }
  if (vals.length < 3) return null;
  vals.sort((a, b) => a - b);
  return { pm25: vals[Math.floor(vals.length / 2)]!, stations: vals.length };
}

// ------------------------------------------------------------- the assessment

export interface FireThreat {
  distanceKm: number;
  bearingFromYou: number;
  frp: number;
  n: number;
  /** Angle between wind direction AT the fire and the fire→you bearing. */
  offAxisDeg: number;
  windAtFireMs: number;
  verdict: 'toward' | 'glancing' | 'away';
  /** Newest detection time for this fire — live mode only. */
  acqMs: number | null;
}

export interface SmokeAssessment {
  locationKey: string;
  firesWithinKm: number;
  radiusKm: number;
  top: FireThreat[];
  anyToward: boolean;
  windValidTime: string;
  /** 'live' = keyed FIRMS query just now; 'cron' = the 6-hourly Tier B snapshot. */
  mode: 'live' | 'cron';
  /** Cron: artifact build time. Live: newest detection, ISO. */
  firesAsOf: string;
  pm: { pm25: number; stations: number } | null;
}

const RADIUS_KM = 400;

/** The ray test for one fire vs one location — the panel and the map popup MUST agree,
 *  so this is the single implementation both call. */
function threatFor(
  c: { lat: number; lon: number; frp: number; n: number; acqMs?: number },
  loc: { lat: number; lon: number },
  grid: WindGrid,
): FireThreat {
  const { u, v } = sampleUv(grid, c.lat, c.lon);
  const windTowardDeg = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
  const fireToYou = bearingDeg(c.lat, c.lon, loc.lat, loc.lon);
  let off = Math.abs(windTowardDeg - fireToYou);
  if (off > 180) off = 360 - off;
  const verdict: FireThreat['verdict'] = off <= 35 ? 'toward' : off <= 70 ? 'glancing' : 'away';
  return {
    distanceKm: Math.round(haversineKm(loc.lat, loc.lon, c.lat, c.lon)),
    bearingFromYou: bearingDeg(loc.lat, loc.lon, c.lat, c.lon),
    frp: c.frp,
    n: c.n,
    offAxisDeg: Math.round(off),
    windAtFireMs: Math.round(Math.hypot(u, v) * 10) / 10,
    verdict,
    acqMs: c.acqMs ?? null,
  };
}

/** Popup-facing wrapper: loads the wind grid on demand, then runs the shared ray test. */
export async function fireRayTest(
  c: { lat: number; lon: number; frp: number; n: number; acqMs?: number },
  loc: { lat: number; lon: number },
): Promise<FireThreat> {
  return threatFor(c, loc, await loadWindGrid());
}

export async function assessSmoke(loc: SavedLocation): Promise<SmokeAssessment> {
  // Live first when a key exists; any live failure falls back to the cron snapshot,
  // labelled as such — the mode is part of the answer, never silent.
  let live: Awaited<ReturnType<typeof fetchLiveFires>> = null;
  try {
    live = await fetchLiveFires(loc);
  } catch {
    live = null;
  }

  const [cron, grid, pm] = await Promise.all([
    live ? Promise.resolve(null) : loadFires(),
    loadWindGrid(),
    fetchPm25(loc).catch(() => null),
  ]);

  const clusters: Array<FireCluster & { acqMs?: number }> = live?.clusters ?? cron!.clusters;
  const near = clusters
    .map((c) => ({ c, distanceKm: haversineKm(loc.lat, loc.lon, c.lat, c.lon) }))
    .filter((x) => x.distanceKm <= RADIUS_KM)
    .sort((a, b) => b.c.frp - a.c.frp);

  const top: FireThreat[] = near.slice(0, 10).map(({ c }) => threatFor(c, loc, grid));

  return {
    locationKey: locationKey(loc),
    firesWithinKm: near.length,
    radiusKm: RADIUS_KM,
    top: top.slice(0, 3),
    anyToward: top.some((t) => t.verdict === 'toward'),
    windValidTime: grid.validTime,
    mode: live ? 'live' : 'cron',
    firesAsOf: live
      ? new Date(live.newestMs).toISOString()
      : (cron!.builtAt ?? new Date(0).toISOString()),
    pm,
  };
}

/** Compass name for a bearing — the panel speaks human, not degrees-only. */
export function compass(deg: number): string {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round(((deg % 360) / 22.5)) % 16]!;
}
