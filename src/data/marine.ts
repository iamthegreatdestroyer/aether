/**
 * Marine — tides, buoys, waves and the moon.
 *
 * The Navionics arbitrage (scouting report, 2026-08-18): boating and fishing apps charge
 * $30–100/yr, and the substance of what they sell is NOAA's own tide predictions, NOAA's own
 * buoys, and solunar tables that are pure astronomy. Measured the same day: CO-OPS tide
 * predictions send `Access-Control-Allow-Origin: *` — Tier A, browser-direct, no key.
 *
 * Lane by lane:
 *   tides      CO-OPS `datagetter` — hi/lo predictions AND observed water level, the pair
 *              that makes verification possible (a tide *prediction* has a *truth*, which is
 *              exactly the shape the forecast ledger already scores).
 *   stations   baked by scripts/build_marine_stations.py — 2.0 MB directory thinned to
 *              268 KB, so nearest-station is a local haversine with no network round trip.
 *   buoys      NDBC sends no CORS header, but publishes every station's latest observation
 *              in ONE file, so the cron bakes it and any location works same-origin.
 *   waves      Open-Meteo's marine model, keyless, same family as the forecast lane.
 *   moon       computed here. Phase and illumination are what tide apps show; the low-
 *              precision lunar series is accurate to well under the resolution anyone reads.
 */

import { fetchJson } from './fetcher';
import { source } from './sources.mjs';
import { haversineKm } from './geo';
import type { SavedLocation } from '../ui/locations';

// ------------------------------------------------------------------ stations

export interface TideStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface BuoyObs {
  id: string;
  lat: number;
  lon: number;
  t: string;
  windDir: number | null;
  windMs: number | null;
  gustMs: number | null;
  waveM: number | null;
  domPeriodS: number | null;
  avgPeriodS: number | null;
  waveDir: number | null;
  pressHpa: number | null;
  airC: number | null;
  waterC: number | null;
}

let stationCache: { stations: TideStation[]; builtAt: string } | null = null;
let buoyCache: { buoys: BuoyObs[]; builtAt: string } | null = null;

async function loadStations(): Promise<{ stations: TideStation[]; builtAt: string }> {
  if (stationCache) return stationCache;
  const r = await fetch('data/marine/stations.json');
  if (!r.ok) throw new Error('tide station directory not built yet — the cron fills it in');
  stationCache = (await r.json()) as { stations: TideStation[]; builtAt: string };
  return stationCache;
}

async function loadBuoys(): Promise<{ buoys: BuoyObs[]; builtAt: string }> {
  if (buoyCache) return buoyCache;
  const r = await fetch('data/marine/buoys.json');
  if (!r.ok) throw new Error('buoy observations not built yet — the cron fills them in');
  buoyCache = (await r.json()) as { buoys: BuoyObs[]; builtAt: string };
  return buoyCache;
}

function nearest<T extends { lat: number; lon: number }>(
  items: T[],
  loc: SavedLocation,
): { item: T; km: number } | null {
  let best: T | null = null;
  let bestKm = Infinity;
  for (const it of items) {
    const km = haversineKm(loc.lat, loc.lon, it.lat, it.lon);
    if (km < bestKm) {
      bestKm = km;
      best = it;
    }
  }
  return best ? { item: best, km: Math.round(bestKm) } : null;
}

// --------------------------------------------------------------------- tides

export interface TideEvent {
  /** UTC ms of the high or low water. */
  ms: number;
  /** 'H' | 'L' as CO-OPS reports it. */
  type: 'H' | 'L';
  /** Height in feet above MLLW — the datum US mariners actually use. */
  feet: number;
}

export interface TideReport {
  station: TideStation;
  distanceKm: number;
  events: TideEvent[];
  /** Latest OBSERVED water level, when the station reports one — the truth side. */
  observed: { ms: number; feet: number } | null;
  /** Interpolated state right now, derived from the surrounding events. */
  now: { risingToward: TideEvent | null; percent: number | null };
}

function coopsDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** CO-OPS returns local station time as "YYYY-MM-DD HH:MM"; ask for GMT and parse as UTC. */
function coopsMs(t: string): number {
  return Date.parse(t.replace(' ', 'T') + 'Z');
}

export async function fetchTides(loc: SavedLocation, days = 3): Promise<TideReport> {
  const dir = await loadStations();
  const found = nearest(dir.stations, loc);
  if (!found) throw new Error('no tide station in the directory');
  const st = found.item;

  const base = source('noaa-coops').baseUrl!;
  const begin = coopsDate(new Date(Date.now() - 6 * 3600 * 1000));
  const end = coopsDate(new Date(Date.now() + days * 86_400_000));
  const common = `application=aether&station=${st.id}&time_zone=gmt&units=english&format=json`;

  const pred = await fetchJson<{ predictions?: Array<{ t: string; v: string; type: 'H' | 'L' }> }>(
    'noaa-coops',
    `${base}?product=predictions&datum=MLLW&interval=hilo&begin_date=${begin}&end_date=${end}&${common}`,
  );
  const events: TideEvent[] = (pred.predictions ?? []).map((p) => ({
    ms: coopsMs(p.t),
    type: p.type,
    feet: Number(p.v),
  }));

  // Observed water level is optional: prediction-only stations (most of them) have no gauge.
  let observed: TideReport['observed'] = null;
  try {
    const obs = await fetchJson<{ data?: Array<{ t: string; v: string }> }>(
      'noaa-coops',
      `${base}?product=water_level&datum=MLLW&date=latest&${common}`,
    );
    const row = obs.data?.[0];
    if (row && Number.isFinite(Number(row.v))) {
      observed = { ms: coopsMs(row.t), feet: Number(row.v) };
    }
  } catch {
    /* a station without a gauge is a normal answer, not a failure */
  }

  // Where are we between the last event and the next one?
  const now = Date.now();
  const prev = [...events].filter((e) => e.ms <= now).pop() ?? null;
  const next = events.find((e) => e.ms > now) ?? null;
  const percent =
    prev && next ? Math.round(((now - prev.ms) / (next.ms - prev.ms)) * 100) : null;

  return { station: st, distanceKm: found.km, events, observed, now: { risingToward: next, percent } };
}

// --------------------------------------------------------------------- buoys

export interface BuoyReport {
  obs: BuoyObs;
  distanceKm: number;
  ageMin: number;
  builtAt: string;
}

export async function fetchBuoy(loc: SavedLocation): Promise<BuoyReport | null> {
  const dir = await loadBuoys();
  // Only buoys actually reporting water or wave data are useful — many land stations in the
  // file report air pressure alone, and a "nearest buoy" with nothing to say is noise.
  const useful = dir.buoys.filter((b) => b.waterC !== null || b.waveM !== null);
  const found = nearest(useful, loc);
  if (!found) return null;
  return {
    obs: found.item,
    distanceKm: found.km,
    ageMin: Math.max(0, Math.round((Date.now() - Date.parse(found.item.t)) / 60_000)),
    builtAt: dir.builtAt,
  };
}

// --------------------------------------------------------------------- waves

export interface WaveForecast {
  time: string[];
  waveM: (number | null)[];
  periodS: (number | null)[];
  waveDir: (number | null)[];
  /** True when the model has no water at this point — an inland pin, honestly reported. */
  dry: boolean;
}

export async function fetchWaves(loc: SavedLocation): Promise<WaveForecast> {
  const u = new URL(source('open-meteo-marine').baseUrl!);
  u.searchParams.set('latitude', loc.lat.toFixed(3));
  u.searchParams.set('longitude', loc.lon.toFixed(3));
  u.searchParams.set('hourly', 'wave_height,wave_period,wave_direction');
  u.searchParams.set('forecast_days', '2');
  u.searchParams.set('timezone', 'UTC');
  const d = await fetchJson<{
    hourly?: {
      time: string[];
      wave_height: (number | null)[];
      wave_period: (number | null)[];
      wave_direction: (number | null)[];
    };
  }>('open-meteo-marine', u.toString());
  const h = d.hourly;
  if (!h) return { time: [], waveM: [], periodS: [], waveDir: [], dry: true };
  const dry = h.wave_height.every((v) => v === null);
  return { time: h.time, waveM: h.wave_height, periodS: h.wave_period, waveDir: h.wave_direction, dry };
}

// ---------------------------------------------------------------------- moon

const DEG = Math.PI / 180;

export interface MoonState {
  /** 0 = new, 0.5 = full, approaching 1 = new again. */
  phase: number;
  illuminatedPct: number;
  name: string;
  glyph: string;
}

/**
 * Moon phase from the standard mean-elongation series. Precision here is far finer than the
 * question deserves — nobody plans a fishing trip on the third decimal of illumination — but
 * a wrong phase is instantly visible to anyone who looks up, so it is worth doing properly
 * rather than with the "days since a known new moon" approximation.
 */
export function moonState(at: Date = new Date()): MoonState {
  const d = (at.getTime() - Date.UTC(2000, 0, 1, 12)) / 86_400_000; // days since J2000.0
  const D = (297.8501921 + 445267.1114034 * (d / 36525)) % 360; // mean elongation
  const M = (357.5291092 + 35999.0502909 * (d / 36525)) % 360; // sun mean anomaly
  const Mp = (134.9633964 + 477198.8675055 * (d / 36525)) % 360; // moon mean anomaly

  // Phase angle of the illuminated limb (Meeus 48.4, principal terms).
  const i =
    180 -
    D -
    6.289 * Math.sin(Mp * DEG) +
    2.1 * Math.sin(M * DEG) -
    1.274 * Math.sin((2 * D - Mp) * DEG) -
    0.658 * Math.sin(2 * D * DEG) -
    0.214 * Math.sin(2 * Mp * DEG) -
    0.11 * Math.sin(D * DEG);
  const illum = (1 + Math.cos(i * DEG)) / 2;

  // Phase fraction 0..1 from mean elongation: 0 new, 0.5 full.
  const phase = (((D % 360) + 360) % 360) / 360;

  const names: Array<[number, string, string]> = [
    [0.03, 'New moon', '🌑'],
    [0.22, 'Waxing crescent', '🌒'],
    [0.28, 'First quarter', '🌓'],
    [0.47, 'Waxing gibbous', '🌔'],
    [0.53, 'Full moon', '🌕'],
    [0.72, 'Waning gibbous', '🌖'],
    [0.78, 'Last quarter', '🌗'],
    [0.97, 'Waning crescent', '🌘'],
    [1.01, 'New moon', '🌑'],
  ];
  const hit = names.find(([edge]) => phase < edge) ?? names[names.length - 1]!;
  return {
    phase: Math.round(phase * 1000) / 1000,
    illuminatedPct: Math.round(illum * 100),
    name: hit[1],
    glyph: hit[2],
  };
}
