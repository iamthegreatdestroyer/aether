/**
 * Honesty labels — per-day predictability that shows its work (plan §9.3-E).
 *
 * Windy prints "70% predictability" on each day header with no visible basis. This module
 * computes the same kind of number from first principles and can explain every step in its
 * tooltip:
 *
 *   predictability = 1 − (ensemble spread ÷ climatological variability)
 *
 * 31 real GFS ensemble members give the spread (verified: day-2 members agree within
 * ±0.8 °C; day-6 they span 13 °C). The 85-year ERA5 record already cached for "Is this
 * weird?" gives the yardstick. 100% = the members agree perfectly; 0% = their spread is as
 * wide as the climate's own scatter, i.e. the forecast tells you nothing beyond the month.
 *
 * The second label is the split flag: when members genuinely disagree about whether it will
 * rain at all (the contested middle, 25–75% of members wet), the day is marked — Windy's
 * "convective rain (difficult to forecast)" made quantitative, with the member count shown.
 */

import { STORE_LATEST, dbGet, dbPut } from './db';
import { fetchJson } from './fetcher';
import { source } from './sources.mjs';
import { climatologySigma } from './climatology';
import { locationKey } from '../ui/locations';
import type { SavedLocation } from '../ui/locations';

export interface DayHonesty {
  date: string;
  /** Ensemble members' daily-high range. */
  tmaxLo: number;
  tmaxHi: number;
  tmaxStd: number;
  members: number;
  /** 0–100, or null while climatology is still downloading. */
  predictabilityPct: number | null;
  climStd: number | null;
  /** Members forecasting measurable rain that day. */
  wetMembers: number;
  /** True when the wet fraction is in the contested middle — rain genuinely undecided. */
  rainSplit: boolean;
  tooltip: string;
}

interface CacheRow {
  fetchedAt: number;
  days: DayHonesty[];
}

/** Spread changes with each model cycle (~6 h); 3 h TTL keeps calls modest and labels fresh. */
const TTL_MS = 3 * 60 * 60 * 1000;
const WET_MM = 0.2;

const cacheKey = (lk: string) => `ens|${lk}`;

export async function fetchHonesty(loc: SavedLocation): Promise<DayHonesty[]> {
  const lk = locationKey(loc);
  const cached = await dbGet<CacheRow>(STORE_LATEST, cacheKey(lk));
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.days;

  const s = source('open-meteo-ensemble');
  if (!s.baseUrl) throw new Error('open-meteo-ensemble contract entry has no baseUrl');
  const u = new URL(s.baseUrl);
  u.searchParams.set('latitude', loc.lat.toFixed(4));
  u.searchParams.set('longitude', loc.lon.toFixed(4));
  u.searchParams.set('hourly', 'temperature_2m,precipitation');
  u.searchParams.set('models', 'gfs_seamless');
  u.searchParams.set('forecast_days', '7');
  u.searchParams.set('timezone', 'auto');

  const raw = await fetchJson<{ hourly: Record<string, unknown> & { time: string[] } }>(
    'open-meteo-ensemble',
    u.toString(),
  );
  const time = raw.hourly.time;
  const tempKeys = Object.keys(raw.hourly).filter((k) => k.startsWith('temperature_2m'));
  const precKeys = Object.keys(raw.hourly).filter((k) => k.startsWith('precipitation'));

  const dates = [...new Set(time.map((t) => t.slice(0, 10)))].sort();
  const days: DayHonesty[] = [];

  for (const date of dates) {
    const idx: number[] = [];
    for (let i = 0; i < time.length; i++) if (time[i]!.startsWith(date)) idx.push(i);

    const tmaxes: number[] = [];
    for (const k of tempKeys) {
      const series = raw.hourly[k] as Array<number | null>;
      let mx = -Infinity;
      for (const i of idx) {
        const v = series[i];
        if (v !== null && v !== undefined && v > mx) mx = v;
      }
      if (mx > -Infinity) tmaxes.push(mx);
    }
    let wet = 0;
    for (const k of precKeys) {
      const series = raw.hourly[k] as Array<number | null>;
      let sum = 0;
      for (const i of idx) sum += series[i] ?? 0;
      if (sum >= WET_MM) wet++;
    }
    if (tmaxes.length < 5) continue;

    const mean = tmaxes.reduce((a, b) => a + b, 0) / tmaxes.length;
    const std = Math.sqrt(tmaxes.reduce((a, b) => a + (b - mean) ** 2, 0) / tmaxes.length);
    const wetFrac = wet / precKeys.length;

    // Climatology may still be downloading on a brand-new location; the label degrades to
    // spread-only rather than blocking, and the next refresh fills the percentage in.
    let predictabilityPct: number | null = null;
    let climStd: number | null = null;
    try {
      const sig = await climatologySigma(loc, date);
      climStd = sig.std;
      predictabilityPct = Math.round(100 * Math.max(0, Math.min(1, 1 - std / sig.std)));
    } catch {
      /* chip shows spread only */
    }

    const rainSplit = wetFrac >= 0.25 && wetFrac <= 0.75;
    const tooltip =
      `${tmaxes.length} GFS ensemble members put the high at ` +
      `${Math.min(...tmaxes).toFixed(0)}–${Math.max(...tmaxes).toFixed(0)}° (σ ${std.toFixed(1)}°). ` +
      (climStd !== null
        ? `Typical variability here for this date: σ ${climStd.toFixed(1)}° (1940–2024) → ` +
          `${predictabilityPct}% predictability.`
        : 'Climatology still loading — showing raw spread.') +
      (rainSplit ? ` Rain contested: ${wet}/${precKeys.length} members wet.` : '');

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

  await dbPut(STORE_LATEST, { fetchedAt: Date.now(), days } satisfies CacheRow, cacheKey(lk));
  return days;
}
