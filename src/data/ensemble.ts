/**
 * Ensemble bundle — honesty labels (P-tour §9.3-E) + the Confidence Cone (P5).
 *
 * One fetch serves both: 31 GEFS members + 51 ECMWF ENS members, hourly, 7 days, in a single
 * multi-model call (~17 KB gzipped). The daily aggregation feeds the per-day predictability
 * badges; the hourly percentile bands feed the cone chart — model disagreement AS the
 * forecast, which is the proposal's Confidence Cone concept (#5) verbatim.
 *
 * Key naming (live-verified): the API canonicalizes model names in suffixes — request
 * `gfs_seamless` and members come back as `temperature_2m_member01_ncep_gefs_seamless`,
 * request `ecmwf_ifs025` and they end `_ecmwf_ifs025_ensemble`, with the control member
 * carrying no `_memberNN` infix. Parsing is by regex, not by echoing the request strings.
 *
 * Honesty labels remain scoped to GEFS members only — the badge SAYS "31 GFS ensemble
 * members", so mixing ENS into that number would falsify its own caption.
 */

import { STORE_LATEST, dbGet, dbPut } from './db';
import { fetchJson } from './fetcher';
import { source } from './sources.mjs';
import { climatologySigma } from './climatology';
import { locationKey } from '../ui/locations';
import type { SavedLocation } from '../ui/locations';

export interface DayHonesty {
  date: string;
  tmaxLo: number;
  tmaxHi: number;
  tmaxStd: number;
  members: number;
  predictabilityPct: number | null;
  climStd: number | null;
  wetMembers: number;
  rainSplit: boolean;
  tooltip: string;
}

export interface HourlyBand {
  min: number[];
  p10: number[];
  median: number[];
  p90: number[];
  max: number[];
  members: number;
}

export interface ConeData {
  time: string[];
  gefs: HourlyBand | null;
  ens: HourlyBand | null;
  /** Fraction of GEFS members with measurable rain, per hour — the bottom strip. */
  wetFracGefs: number[];
}

interface Bundle {
  fetchedAt: number;
  days: DayHonesty[];
  cone: ConeData;
}

const TTL_MS = 3 * 60 * 60 * 1000;
const WET_MM = 0.1;
/** v2: cache shape changed when the cone joined the bundle. */
const cacheKey = (lk: string) => `ens2|${lk}`;

const MEMBER_RE = /^temperature_2m(?:_member(\d+))?_(.+)$/;
const PRECIP_RE = /^precipitation(?:_member(\d+))?_(.+)$/;

function isGefs(model: string): boolean {
  return model.includes('gefs');
}
function isEns(model: string): boolean {
  return model.includes('ifs025_ensemble') || model.includes('ecmwf');
}

function bandOf(series: number[][], nHours: number): HourlyBand | null {
  if (series.length < 5) return null;
  const min: number[] = [];
  const p10: number[] = [];
  const median: number[] = [];
  const p90: number[] = [];
  const max: number[] = [];
  for (let h = 0; h < nHours; h++) {
    const vals = series.map((s) => s[h]).filter((v): v is number => v != null);
    if (vals.length < 5) {
      min.push(NaN); p10.push(NaN); median.push(NaN); p90.push(NaN); max.push(NaN);
      continue;
    }
    vals.sort((a, b) => a - b);
    const q = (f: number) => vals[Math.min(vals.length - 1, Math.round(f * (vals.length - 1)))]!;
    min.push(vals[0]!);
    p10.push(q(0.1));
    median.push(q(0.5));
    p90.push(q(0.9));
    max.push(vals[vals.length - 1]!);
  }
  return { min, p10, median, p90, max, members: series.length };
}

async function fetchBundle(loc: SavedLocation): Promise<Bundle> {
  const lk = locationKey(loc);
  const cached = await dbGet<Bundle>(STORE_LATEST, cacheKey(lk));
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;

  const s = source('open-meteo-ensemble');
  const u = new URL(s.baseUrl!);
  u.searchParams.set('latitude', loc.lat.toFixed(4));
  u.searchParams.set('longitude', loc.lon.toFixed(4));
  u.searchParams.set('hourly', 'temperature_2m,precipitation');
  u.searchParams.set('models', 'gfs_seamless,ecmwf_ifs025');
  u.searchParams.set('forecast_days', '7');
  u.searchParams.set('timezone', 'auto');

  const raw = await fetchJson<{ hourly: Record<string, unknown> & { time: string[] } }>(
    'open-meteo-ensemble',
    u.toString(),
  );
  const time = raw.hourly.time;

  const gefsTemp: number[][] = [];
  const ensTemp: number[][] = [];
  const gefsPrec: number[][] = [];
  for (const k of Object.keys(raw.hourly)) {
    const mt = MEMBER_RE.exec(k);
    if (mt) {
      const series = raw.hourly[k] as number[];
      if (isGefs(mt[2]!)) gefsTemp.push(series);
      else if (isEns(mt[2]!)) ensTemp.push(series);
      continue;
    }
    const mp = PRECIP_RE.exec(k);
    if (mp && isGefs(mp[2]!)) gefsPrec.push(raw.hourly[k] as number[]);
  }

  const wetFracGefs = time.map((_, h) => {
    if (gefsPrec.length === 0) return 0;
    let wet = 0;
    for (const s2 of gefsPrec) if ((s2[h] ?? 0) >= WET_MM) wet++;
    return +(wet / gefsPrec.length).toFixed(2);
  });

  const cone: ConeData = {
    time,
    gefs: bandOf(gefsTemp, time.length),
    ens: bandOf(ensTemp, time.length),
    wetFracGefs,
  };

  // ---- daily honesty (GEFS only, matching its own caption)
  const dates = [...new Set(time.map((t) => t.slice(0, 10)))].sort();
  const days: DayHonesty[] = [];
  for (const date of dates) {
    const idx: number[] = [];
    for (let i = 0; i < time.length; i++) if (time[i]!.startsWith(date)) idx.push(i);
    const tmaxes: number[] = [];
    for (const s2 of gefsTemp) {
      let mx = -Infinity;
      for (const i of idx) {
        const v = s2[i];
        if (v != null && v > mx) mx = v;
      }
      if (mx > -Infinity) tmaxes.push(mx);
    }
    let wet = 0;
    for (const s2 of gefsPrec) {
      let sum = 0;
      for (const i of idx) sum += s2[i] ?? 0;
      if (sum >= 0.2) wet++;
    }
    if (tmaxes.length < 5) continue;
    const mean = tmaxes.reduce((a, b) => a + b, 0) / tmaxes.length;
    const std = Math.sqrt(tmaxes.reduce((a, b) => a + (b - mean) ** 2, 0) / tmaxes.length);
    const wetFrac = gefsPrec.length ? wet / gefsPrec.length : 0;

    let predictabilityPct: number | null = null;
    let climStd: number | null = null;
    try {
      const sig = await climatologySigma(loc, date);
      climStd = sig.std;
      predictabilityPct = Math.round(100 * Math.max(0, Math.min(1, 1 - std / sig.std)));
    } catch {
      /* spread-only badge */
    }

    const rainSplit = wetFrac >= 0.25 && wetFrac <= 0.75;
    const tooltip =
      `${tmaxes.length} GFS ensemble members put the high at ` +
      `${Math.min(...tmaxes).toFixed(0)}–${Math.max(...tmaxes).toFixed(0)}° (σ ${std.toFixed(1)}°). ` +
      (climStd !== null
        ? `Typical variability here for this date: σ ${climStd.toFixed(1)}° (1940–2024) → ` +
          `${predictabilityPct}% predictability.`
        : 'Climatology still loading — showing raw spread.') +
      (rainSplit ? ` Rain contested: ${wet}/${gefsPrec.length} members wet.` : '');

    days.push({
      date,
      tmaxLo: Math.min(...tmaxes),
      tmaxHi: Math.max(...tmaxes),
      tmaxStd: +std.toFixed(2),
      members: tmaxes.length,
      predictabilityPct,
      climStd: climStd !== null ? +climStd.toFixed(2) : null,
      wetMembers: wet,
      rainSplit,
      tooltip,
    });
  }

  const bundle: Bundle = { fetchedAt: Date.now(), days, cone };
  await dbPut(STORE_LATEST, bundle, cacheKey(lk));
  return bundle;
}

export async function fetchHonesty(loc: SavedLocation): Promise<DayHonesty[]> {
  return (await fetchBundle(loc)).days;
}

export async function fetchCone(loc: SavedLocation): Promise<ConeData> {
  return (await fetchBundle(loc)).cone;
}
