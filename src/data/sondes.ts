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

/** Most recent sonde within 300 km / 12 h, or null — absence is a valid, displayed answer. */
export async function nearestSonde(loc: SavedLocation): Promise<SondeFrame | null> {
  const base = source('sondehub').baseUrl;
  const listing = await fetchJson<Record<string, SondeListing>>(
    'sondehub',
    `${base}/sondes?lat=${loc.lat.toFixed(3)}&lon=${loc.lon.toFixed(3)}&distance=${SEARCH_RADIUS_M}&last=${LOOKBACK_S}`,
  );
  const frames = Object.values(listing);
  if (frames.length === 0) return null;
  frames.sort((a, b) => b.datetime.localeCompare(a.datetime));
  const f = frames[0]!;
  return {
    serial: f.serial,
    type: f.type ?? f.manufacturer ?? 'radiosonde',
    lat: f.lat,
    lon: f.lon,
    altM: f.alt,
    tempC: typeof f.temp === 'number' ? f.temp : null,
    datetime: f.datetime,
    distanceKm: Math.round(haversineKm(loc.lat, loc.lon, f.lat, f.lon)),
    ageMin: Math.round((Date.now() - Date.parse(f.datetime)) / 60_000),
  };
}

/** Altitude→temperature profile from Open-Meteo pressure levels at the SONDE's position. */
async function modelProfile(
  lat: number,
  lon: number,
): Promise<Array<{ altM: number; tempC: number }>> {
  const om = source('open-meteo');
  const u = new URL(om.baseUrl!);
  u.searchParams.set('latitude', lat.toFixed(3));
  u.searchParams.set('longitude', lon.toFixed(3));
  u.searchParams.set(
    'hourly',
    PRESSURE_LEVELS.flatMap((p) => [`temperature_${p}hPa`, `geopotential_height_${p}hPa`]).join(','),
  );
  u.searchParams.set('forecast_days', '1');
  u.searchParams.set('timezone', 'UTC');
  const d = await fetchJson<{ hourly: Record<string, Array<number | null>> & { time: string[] } }>(
    'open-meteo',
    u.toString(),
  );
  // Current UTC hour's column.
  const nowHour = new Date().toISOString().slice(0, 13) + ':00';
  const idx = Math.max(0, d.hourly.time.findIndex((t) => t === nowHour));
  const profile: Array<{ altM: number; tempC: number }> = [];
  for (const p of PRESSURE_LEVELS) {
    const t = d.hourly[`temperature_${p}hPa`]?.[idx];
    const h = d.hourly[`geopotential_height_${p}hPa`]?.[idx];
    if (typeof t === 'number' && typeof h === 'number') profile.push({ altM: h, tempC: t });
  }
  return profile.sort((a, b) => a.altM - b.altM);
}

export async function balloonTruth(loc: SavedLocation): Promise<BalloonTruth | null> {
  const sonde = await nearestSonde(loc);
  if (!sonde) return null;

  let modelTempC: number | null = null;
  if (sonde.tempC !== null) {
    try {
      // Profile at the sonde's own position — the column the balloon is actually in.
      const prof = await modelProfile(sonde.lat, sonde.lon);
      for (let i = 0; i < prof.length - 1; i++) {
        const lo = prof[i]!;
        const hi = prof[i + 1]!;
        if (sonde.altM >= lo.altM && sonde.altM <= hi.altM) {
          const f = (sonde.altM - lo.altM) / (hi.altM - lo.altM);
          modelTempC = +(lo.tempC + f * (hi.tempC - lo.tempC)).toFixed(1);
          break;
        }
      }
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
    profileSource: 'Open-Meteo best_match pressure levels',
  };
}
