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

import { fetchJson, hasNativeTransport } from './fetcher';
import { source } from './sources.mjs';

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
