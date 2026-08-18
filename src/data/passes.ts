/**
 * Satellite pass prediction — the contract's last unconsumed promise (celestrak, in the
 * contract since day one with role "Satellite passes").
 *
 * This module's core is PURE — TLE lines + coordinates in, passes out, no browser
 * dependencies — precisely so the spike harness can bundle the exact shipped code and
 * cross-check it against Skyfield (an independent Python ephemeris library) with the same
 * elements and times. SGP4 itself comes from satellite.js; what we add on top:
 *
 *   - pass assembly: 30 s sampling, 10° elevation threshold, AOS/LOS/max-elevation
 *   - VISIBILITY, the part that makes it a feature: a pass is watchable only when the
 *     observer is in twilight-or-darker (sun < -6°) while the station is still sunlit
 *     (cylindrical Earth-shadow test — the standard approximation for visual passes)
 *
 * Sun position is the Astronomical Almanac low-precision formula (~0.01° — far better than
 * the 10° threshold needs). All times UTC ms; the UI shows countdowns, which need no zone.
 */

import * as satellite from 'satellite.js';

export const MIN_ELEV_DEG = 10;
const STEP_S = 30;
/** Civil-twilight-or-darker at the observer; the ISS is bright enough from about here. */
const DARK_SUN_ELEV_DEG = -6;

const R_EARTH_KM = 6371;
const AU_KM = 1.496e8;
const DEG = Math.PI / 180;

export interface Pass {
  /** Above-threshold window (UTC ms). */
  aosMs: number;
  losMs: number;
  maxElevDeg: number;
  maxElevMs: number;
  aosAzDeg: number;
  losAzDeg: number;
  /** True if any part of the pass is dark-observer + sunlit-satellite. */
  visible: boolean;
  visibleFromMs: number | null;
  visibleToMs: number | null;
}

/** Sun direction in ECI (unit vector) — Astronomical Almanac low-precision. */
function sunEci(ms: number): { x: number; y: number; z: number } {
  const n = (ms - Date.UTC(2000, 0, 1, 12)) / 86_400_000; // days since J2000.0
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  return {
    x: Math.cos(lambda),
    y: Math.cos(eps) * Math.sin(lambda),
    z: Math.sin(eps) * Math.sin(lambda),
  };
}

/** Sun elevation at an observer (degrees) — drives the "is it dark yet" half of visibility. */
export function sunElevationDeg(lat: number, lon: number, ms: number): number {
  const s = sunEci(ms);
  const gmst = satellite.gstime(new Date(ms));
  const sunEcf = satellite.eciToEcf({ x: s.x * AU_KM, y: s.y * AU_KM, z: s.z * AU_KM }, gmst);
  const observer = { latitude: lat * DEG, longitude: lon * DEG, height: 0 };
  const la = satellite.ecfToLookAngles(observer, sunEcf);
  return la.elevation / DEG;
}

/** Cylindrical Earth-shadow test — the standard approximation for visual-pass tools. */
function isSunlit(posEci: { x: number; y: number; z: number }, ms: number): boolean {
  const s = sunEci(ms);
  const along = posEci.x * s.x + posEci.y * s.y + posEci.z * s.z;
  if (along > 0) return true; // day side of Earth
  const px = posEci.x - along * s.x;
  const py = posEci.y - along * s.y;
  const pz = posEci.z - along * s.z;
  return Math.hypot(px, py, pz) > R_EARTH_KM;
}

/**
 * All passes of one TLE over one point in [startMs, startMs + windowHours). Pure: same
 * inputs, same outputs, any runtime — the spike cross-check depends on this purity.
 */
export function computePasses(
  tle1: string,
  tle2: string,
  lat: number,
  lon: number,
  startMs: number,
  windowHours: number,
): Pass[] {
  const satrec = satellite.twoline2satrec(tle1, tle2);
  const observer = { latitude: lat * DEG, longitude: lon * DEG, height: 0 };
  const passes: Pass[] = [];
  let current: Pass | null = null;

  const endMs = startMs + windowHours * 3_600_000;
  for (let ms = startMs; ms < endMs; ms += STEP_S * 1000) {
    const date = new Date(ms);
    const pv = satellite.propagate(satrec, date);
    if (!pv || typeof pv.position === 'boolean') {
      continue; // propagation blew up (decayed elements) — skip the sample honestly
    }
    const gmst = satellite.gstime(date);
    const ecf = satellite.eciToEcf(pv.position, gmst);
    const la = satellite.ecfToLookAngles(observer, ecf);
    const elevDeg = la.elevation / DEG;
    const azDeg = ((la.azimuth / DEG) + 360) % 360;

    if (elevDeg >= MIN_ELEV_DEG) {
      if (!current) {
        current = {
          aosMs: ms,
          losMs: ms,
          maxElevDeg: elevDeg,
          maxElevMs: ms,
          aosAzDeg: azDeg,
          losAzDeg: azDeg,
          visible: false,
          visibleFromMs: null,
          visibleToMs: null,
        };
      }
      current.losMs = ms;
      current.losAzDeg = azDeg;
      if (elevDeg > current.maxElevDeg) {
        current.maxElevDeg = elevDeg;
        current.maxElevMs = ms;
      }
      if (sunElevationDeg(lat, lon, ms) < DARK_SUN_ELEV_DEG && isSunlit(pv.position, ms)) {
        current.visible = true;
        current.visibleFromMs ??= ms;
        current.visibleToMs = ms;
      }
    } else if (current) {
      passes.push(current);
      current = null;
    }
  }
  if (current) passes.push(current);
  return passes;
}

/** Compass word for an azimuth — pass directions read better as words. */
export function azWord(azDeg: number): string {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round(((azDeg % 360) / 22.5)) % 16]!;
}
