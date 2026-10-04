/**
 * Balloon Truth — live radiosondes as the atmosphere's answer key (proposal §4.1.3).
 *
 * ~384 sondes ascend daily through SondeHub's receiver network; no consumer weather app
 * surfaces them. This module finds the most recent sonde near a location and diffs its
 * measured temperature against what the model says the air at that altitude should be.
 *
 * Licence discipline (CC BY-SA 2.0, share-alike): sonde data is DISPLAYED ALONGSIDE model
 * data — two labelled columns, never blended into a derived product — which is what keeps
 * the share-alike from propagating (proposal §5.3.2). Attribution is rendered on the card
 * itself, not just the sources screen.
 *
 * The model comparison interpolates on ALTITUDE, not pressure, because the DFM sondes that
 * dominate US launches report no pressure in their telemetry (verified live). Open-Meteo's
 * geopotential heights turn pressure levels into an altitude→temperature profile.
 */

import { fetchJson } from './fetcher';
import { haversineKm } from './geo';
import { source } from './sources.mjs';
import type { SavedLocation } from '../ui/locations';

export interface SondeFrame {
  serial: string;
  type: string;
  lat: number;
  lon: number;
  altM: number;
  tempC: number | null;
  datetime: string;
  distanceKm: number;
  ageMin: number;
}

export interface BalloonTruth {
  sonde: SondeFrame;
  /** Model temperature interpolated to the sonde's altitude, or null out of range. */
  modelTempC: number | null;
  /** sonde − model; positive = atmosphere warmer than the model thinks. */
  deltaC: number | null;
  profileSource: string;
}

const SEARCH_RADIUS_M = 300_000;
const LOOKBACK_S = 43_200; // 12 h — spans the last synoptic launch cycle

const PRESSURE_LEVELS = [925, 850, 700, 500, 400, 300, 250, 200] as const;

interface SondeListing {
  serial: string;
  type?: string;
  manufacturer?: string;
  lat: number;
  lon: number;
  alt: number;
  temp?: number | null;
  datetime: string;
}

/**
 * Which sonde to show. Measured 2026-10-03: "newest frame wins" put a Vaisala LMS6 that reports
 * NO temperature (197 km away) ahead of a DFM 21 km from Home that was transmitting live, so
 * the panel showed an unusable sonde while a good one was in the next row. Rules:
 *   - a sonde without a temperature cannot answer "what is the air doing", so it is skipped
 *     (it is only used if nothing else exists, so the row still says a sonde is out there);
 *   - nearest wins, with a staleness penalty of 1 km per 6 min, so a balloon that landed 12 h
 *     ago (a 120 km handicap) does not outrank one still reporting a few km further away.
 */
export function pickSonde(frames: SondeFrame[]): SondeFrame | null {
  if (frames.length === 0) return null;
  const usable = frames.filter((f) => f.tempC !== null);
  const pool = usable.length > 0 ? usable : frames;
  const score = (f: SondeFrame) => f.distanceKm + Math.max(0, f.ageMin) / 6;
  return pool.reduce((best, f) => (score(f) < score(best) ? f : best));
}

/** Best sonde within 300 km / 12 h, or null — absence is a valid, displayed answer. */
export async function nearestSonde(loc: SavedLocation): Promise<SondeFrame | null> {
  const base = source('sondehub').baseUrl;
  const listing = await fetchJson<Record<string, SondeListing>>(
    'sondehub',
    `${base}/sondes?lat=${loc.lat.toFixed(3)}&lon=${loc.lon.toFixed(3)}&distance=${SEARCH_RADIUS_M}&last=${LOOKBACK_S}`,
  );
  const now = Date.now();
  return pickSonde(
    Object.values(listing).map((f) => ({
      serial: f.serial,
      type: f.type ?? f.manufacturer ?? 'radiosonde',
      lat: f.lat,
      lon: f.lon,
      altM: f.alt,
      tempC: typeof f.temp === 'number' ? f.temp : null,
      datetime: f.datetime,
      distanceKm: Math.round(haversineKm(loc.lat, loc.lon, f.lat, f.lon)),
      ageMin: Math.round((now - Date.parse(f.datetime)) / 60_000),
    })),
  );
}

export interface ProfilePoint {
  altM: number;
  tempC: number;
}

/**
 * Altitude→temperature profile from Open-Meteo at the SONDE's position, for the hour the sonde
 * was actually in the air. Two defects fixed 2026-10-03: the column used was always the CURRENT
 * UTC hour, so a frame up to 12 h old was compared with a model valid hours later (past_days=1
 * keeps yesterday's hours available after 00Z); and nothing existed below the 925 hPa level
 * (~750 m), so every sonde on or near the ground — most sondes are, for their first and last
 * minutes — returned no comparison. The model's own surface (2 m temperature at model
 * elevation) now anchors the bottom of the profile.
 */
async function modelProfile(lat: number, lon: number, validAt: string): Promise<ProfilePoint[]> {
  const om = source('open-meteo');
  const u = new URL(om.baseUrl!);
  u.searchParams.set('latitude', lat.toFixed(3));
  u.searchParams.set('longitude', lon.toFixed(3));
  u.searchParams.set(
    'hourly',
    [
      'temperature_2m',
      ...PRESSURE_LEVELS.flatMap((p) => [`temperature_${p}hPa`, `geopotential_height_${p}hPa`]),
    ].join(','),
  );
  u.searchParams.set('past_days', '1');
  u.searchParams.set('forecast_days', '1');
  u.searchParams.set('timezone', 'UTC');
  const d = await fetchJson<{
    elevation?: number;
    hourly: Record<string, Array<number | null>> & { time: string[] };
  }>('open-meteo', u.toString());
  const hour = nearestHour(validAt);
  const idx = d.hourly.time.findIndex((t) => t === hour);
  if (idx < 0) throw new Error(`model has no column for ${hour}`);
  const profile: ProfilePoint[] = [];
  const t2 = d.hourly['temperature_2m']?.[idx];
  if (typeof t2 === 'number' && typeof d.elevation === 'number') {
    profile.push({ altM: d.elevation + 2, tempC: t2 });
  }
  for (const p of PRESSURE_LEVELS) {
    const t = d.hourly[`temperature_${p}hPa`]?.[idx];
    const h = d.hourly[`geopotential_height_${p}hPa`]?.[idx];
    if (typeof t === 'number' && typeof h === 'number') profile.push({ altM: h, tempC: t });
  }
  return profile.sort((a, b) => a.altM - b.altM);
}

/** "2026-10-03T14:41:55Z" -> "2026-10-03T15:00" (Open-Meteo's hourly key, nearest hour). */
export function nearestHour(iso: string): string {
  const t = Math.round(Date.parse(iso) / 3_600_000) * 3_600_000;
  return new Date(t).toISOString().slice(0, 13) + ':00';
}

/**
 * Linear interpolation on altitude. A sonde within 150 m BELOW the lowest model point (GPS
 * height vs model terrain, valley floors) takes that point's value; anything further outside
 * the profile is null rather than an extrapolation.
 */
export function interpolateProfile(prof: ProfilePoint[], altM: number): number | null {
  if (prof.length === 0) return null;
  const first = prof[0]!;
  if (altM < first.altM) return first.altM - altM <= 150 ? +first.tempC.toFixed(1) : null;
  for (let i = 0; i < prof.length - 1; i++) {
    const lo = prof[i]!;
    const hi = prof[i + 1]!;
    if (altM >= lo.altM && altM <= hi.altM) {
      const f = hi.altM === lo.altM ? 0 : (altM - lo.altM) / (hi.altM - lo.altM);
      return +(lo.tempC + f * (hi.tempC - lo.tempC)).toFixed(1);
    }
  }
  return null;
}

export async function balloonTruth(loc: SavedLocation): Promise<BalloonTruth | null> {
  const sonde = await nearestSonde(loc);
  if (!sonde) return null;

  let modelTempC: number | null = null;
  if (sonde.tempC !== null) {
    try {
      // Profile at the sonde's own position and time — the column the balloon was actually in.
      modelTempC = interpolateProfile(
        await modelProfile(sonde.lat, sonde.lon, sonde.datetime),
        sonde.altM,
      );
    } catch {
      /* model column unavailable — the sonde still displays alone */
    }
  }

  return {
    sonde,
    modelTempC,
    deltaC:
      modelTempC !== null && sonde.tempC !== null
        ? +(sonde.tempC - modelTempC).toFixed(1)
        : null,
    profileSource: 'Open-Meteo best_match: 2 m temperature + pressure levels, at the sonde time',
  };
}
