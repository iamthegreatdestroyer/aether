/**
 * The trajectory sampler — `f(position, arrival_time)` (plan §9.3-D).
 *
 * Every other feature in this app asks "what will the weather be at X at forecast hour H?".
 * A route asks a different question: "what will it be WHERE I AM, WHEN I'm there?" Leaving
 * at 15:00, the midpoint must be scored at 16:30, not now. Windy ships this as its
 * distance/planning tool (Car/hike | Boat | VFR | IFR); the same machinery is the future
 * home of the proposal's Smoke Story (fires → trajectory → arrival timeline), which stays
 * explicitly deferred until its fire/PM data lanes exist.
 *
 * Cost discipline: sample points are chosen by TRAVEL TIME (one per ~30 min underway, 3–12
 * total), and the whole route is ONE Open-Meteo request — the multi-location form
 * (comma-separated lat/lon lists) was live-verified to return an ordered per-point array
 * before this file was written. UTC throughout, so a route crossing timezones scores
 * arrival times on one clock internally and renders local times per point.
 */

import { fetchJson } from './fetcher';
import { source } from './sources.mjs';
import { haversineKm, lerpPoint } from './geo';
import { describeWeather } from './openmeteo';

export interface Waypoint {
  lat: number;
  lon: number;
}

export const ROUTE_MODES = {
  car: { label: '🚗 Car', kmh: 90 },
  bike: { label: '🚴 Bike', kmh: 18 },
  hike: { label: '🥾 Hike', kmh: 4.5 },
  boat: { label: '⛵ Boat', kmh: 12 },
} as const;
export type RouteMode = keyof typeof ROUTE_MODES;

export interface RouteSample {
  lat: number;
  lon: number;
  kmFromStart: number;
  arrivalIso: string;
  arrivalLocal: string;
  tempC: number | null;
  precipProb: number | null;
  windKmh: number | null;
  gustKmh: number | null;
  weatherLabel: string;
  weatherGlyph: string;
}

export interface RoutePlan {
  mode: RouteMode;
  totalKm: number;
  durationH: number;
  departIso: string;
  samples: RouteSample[];
  /** The stretch to worry about, or null when the whole route looks dry. */
  worst: { kmFromStart: number; arrivalLocal: string; precipProb: number } | null;
}

const MIN_SAMPLES = 3;
const MAX_SAMPLES = 12;
const SAMPLE_EVERY_H = 0.5;

/** Resample the waypoint polyline into points evenly spaced by travel TIME. */
function resample(waypoints: Waypoint[], kmh: number): Array<Waypoint & { kmFromStart: number }> {
  const legs: Array<{ a: Waypoint; b: Waypoint; km: number }> = [];
  let totalKm = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i]!;
    const b = waypoints[i + 1]!;
    const km = haversineKm(a.lat, a.lon, b.lat, b.lon);
    legs.push({ a, b, km });
    totalKm += km;
  }
  const durationH = totalKm / kmh;
  const n = Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.ceil(durationH / SAMPLE_EVERY_H) + 1));

  const out: Array<Waypoint & { kmFromStart: number }> = [];
  for (let s = 0; s < n; s++) {
    const target = (totalKm * s) / (n - 1);
    let acc = 0;
    for (const leg of legs) {
      if (acc + leg.km >= target || leg === legs[legs.length - 1]) {
        const f = leg.km > 0 ? (target - acc) / leg.km : 0;
        const p = lerpPoint(leg.a.lat, leg.a.lon, leg.b.lat, leg.b.lon, Math.min(1, Math.max(0, f)));
        out.push({ ...p, kmFromStart: target });
        break;
      }
      acc += leg.km;
    }
  }
  return out;
}

interface OmPoint {
  hourly: {
    time: string[];
    temperature_2m: Array<number | null>;
    precipitation_probability: Array<number | null>;
    wind_speed_10m: Array<number | null>;
    wind_gusts_10m: Array<number | null>;
    weather_code: Array<number | null>;
  };
}

export async function sampleRoute(
  waypoints: Waypoint[],
  mode: RouteMode,
  departMs: number,
): Promise<RoutePlan> {
  if (waypoints.length < 2) throw new Error('a route needs at least two waypoints');
  const { kmh } = ROUTE_MODES[mode];
  const points = resample(waypoints, kmh);
  const last = points[points.length - 1]!;
  const totalKm = last.kmFromStart;
  const durationH = totalKm / kmh;
  if (durationH > 46) throw new Error('route exceeds the 48 h forecast window — split the trip');

  const om = source('open-meteo');
  const u = new URL(om.baseUrl!);
  u.searchParams.set('latitude', points.map((p) => p.lat.toFixed(3)).join(','));
  u.searchParams.set('longitude', points.map((p) => p.lon.toFixed(3)).join(','));
  u.searchParams.set(
    'hourly',
    'temperature_2m,precipitation_probability,wind_speed_10m,wind_gusts_10m,weather_code',
  );
  u.searchParams.set('forecast_days', '3');
  u.searchParams.set('timezone', 'UTC');

  const raw = await fetchJson<OmPoint | OmPoint[]>('open-meteo', u.toString());
  const results = Array.isArray(raw) ? raw : [raw];
  if (results.length !== points.length) {
    throw new Error(`expected ${points.length} route points, got ${results.length}`);
  }

  const samples: RouteSample[] = points.map((p, i) => {
    const arrivalMs = departMs + (p.kmFromStart / kmh) * 3_600_000;
    const h = results[i]!.hourly;
    const t0 = Date.parse(`${h.time[0]}:00Z`.replace(':00:00Z', ':00Z'));
    const idx = Math.max(0, Math.min(h.time.length - 1, Math.round((arrivalMs - t0) / 3_600_000)));
    const code = h.weather_code[idx];
    const w = code !== null && code !== undefined ? describeWeather(code) : { label: '?', glyph: '·' };
    return {
      lat: p.lat,
      lon: p.lon,
      kmFromStart: Math.round(p.kmFromStart),
      arrivalIso: new Date(arrivalMs).toISOString(),
      arrivalLocal: new Date(arrivalMs).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      }),
      tempC: h.temperature_2m[idx] ?? null,
      precipProb: h.precipitation_probability[idx] ?? null,
      windKmh: h.wind_speed_10m[idx] ?? null,
      gustKmh: h.wind_gusts_10m[idx] ?? null,
      weatherLabel: w.label,
      weatherGlyph: w.glyph,
    };
  });

  const wettest = samples.reduce(
    (best, s) => ((s.precipProb ?? 0) > (best?.precipProb ?? 0) ? s : best),
    null as RouteSample | null,
  );
  return {
    mode,
    totalKm: Math.round(totalKm),
    durationH: +durationH.toFixed(1),
    departIso: new Date(departMs).toISOString(),
    samples,
    worst:
      wettest && (wettest.precipProb ?? 0) >= 50
        ? {
            kmFromStart: wettest.kmFromStart,
            arrivalLocal: wettest.arrivalLocal,
            precipProb: wettest.precipProb!,
          }
        : null,
  };
}
