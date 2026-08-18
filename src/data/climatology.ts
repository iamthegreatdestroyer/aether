/**
 * "Is this weird?" — a personal Extreme Forecast Index (plan §9.2-A).
 *
 * The reframing came from seeing Windy render ECMWF's EFI: every other layer answers "what
 * will it be?"; EFI answers "should you care?" — the forecast as a percentile of what is
 * NORMAL at that exact place and time of year. 30 °C is a shrug in Phoenix and a headline in
 * Helsinki. Windy computes it against model climatology; Aether computes it against **85
 * years of ERA5 at the user's exact point**, one keyless call, cached forever.
 *
 * Method, validated against real NYC history before this file was written (probe 2026-08-17:
 * 31,047 days, no gaps; 30 °C ≈ p84, 33 °C ≈ p97, 35 °C ≈ p99 for mid-August — the numbers a
 * meteorologist would expect):
 *   - fetch daily tmax/tmin 1940→2024 once per location (~162 KB gzipped), keep in IndexedDB
 *   - for a forecast day, pool every historical day within ±7 calendar days (n ≈ 1275)
 *   - the forecast high's rank in that pool is the answer
 *
 * The window ends at a FIXED complete year (2024) on purpose: the cache never staleness-churns,
 * and the baseline doesn't drift as this year's data arrives. This is also the second
 * compounding axis: the same ledger that scores models will eventually let "weird" be asked
 * against the app's own local record, not just the reanalysis.
 */

import { STORE_CLIMATOLOGY, dbGet, dbPut } from './db';
import { fetchJson } from './fetcher';
import { source } from './sources.mjs';
import { locationKey } from '../ui/locations';
import type { SavedLocation } from '../ui/locations';

const START = '1940-01-01';
/** Fixed complete-years endpoint — bump deliberately (with a cache-key change), never rolling. */
const END = '2024-12-31';
const WINDOW_DAYS = 7;

interface ClimatologyRecord {
  fetchedAt: number;
  range: string;
  /** Compact parallel arrays: month*100+day, tmax, tmin. Nulls dropped at ingest. */
  monthDay: number[];
  tmax: number[];
  tmin: number[];
}

export interface Weirdness {
  /** Percentile of the forecast high within the historical window, 0–100. */
  tmaxPct: number;
  tminPct: number;
  n: number;
  years: string;
  label: string;
  glyph: string;
  /** Plain-language sentence for the card, receipts-style: claim + evidence. */
  sentence: string;
}

const cacheKey = (lk: string) => `${lk}|${START}|${END}`;

async function loadOrFetch(loc: SavedLocation): Promise<ClimatologyRecord> {
  const key = cacheKey(locationKey(loc));
  const cached = await dbGet<ClimatologyRecord>(STORE_CLIMATOLOGY, key);
  if (cached) return cached;

  const s = source('open-meteo-archive');
  if (!s.baseUrl) throw new Error('open-meteo-archive contract entry has no baseUrl');
  const u = new URL(s.baseUrl);
  u.searchParams.set('latitude', loc.lat.toFixed(4));
  u.searchParams.set('longitude', loc.lon.toFixed(4));
  u.searchParams.set('start_date', START);
  u.searchParams.set('end_date', END);
  u.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min');
  u.searchParams.set('timezone', 'auto');

  const raw = await fetchJson<{
    daily: { time: string[]; temperature_2m_max: Array<number | null>; temperature_2m_min: Array<number | null> };
  }>('open-meteo-archive', u.toString());

  // Compact at ingest: month-day code + values, nulls dropped. ~3× smaller than the raw JSON
  // and exactly the shape the percentile query wants.
  const monthDay: number[] = [];
  const tmax: number[] = [];
  const tmin: number[] = [];
  const { time, temperature_2m_max: xs, temperature_2m_min: ns } = raw.daily;
  for (let i = 0; i < time.length; i++) {
    const x = xs[i];
    const n = ns[i];
    const t = time[i];
    if (x == null || n == null || t === undefined) continue;
    monthDay.push(Number(t.slice(5, 7)) * 100 + Number(t.slice(8, 10)));
    tmax.push(x);
    tmin.push(n);
  }
  const record: ClimatologyRecord = { fetchedAt: Date.now(), range: `${START}..${END}`, monthDay, tmax, tmin };
  await dbPut(STORE_CLIMATOLOGY, record, key);
  return record;
}

/** Distance in calendar days between two month-day codes, wrapping the year boundary. */
function mdDistance(a: number, b: number): number {
  const doy = (md: number) => {
    const cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    return (cum[Math.floor(md / 100) - 1] ?? 0) + (md % 100);
  };
  const d = Math.abs(doy(a) - doy(b));
  return Math.min(d, 365 - d);
}

function percentile(value: number, pool: number[]): number {
  let below = 0;
  for (const v of pool) if (v < value) below++;
  return Math.round((100 * below) / pool.length);
}

function tier(tmaxPct: number, tminPct: number): { label: string; glyph: string; frag: string } {
  // The warm-night check matters: a p97 overnight low is a health story even when the day is
  // ordinary. Highs take precedence for the label; unusual nights get their own wording.
  if (tmaxPct >= 99) return { label: 'extreme heat for the date', glyph: '🔥', frag: 'hotter than 99% of' };
  if (tmaxPct >= 90) return { label: 'unusually warm', glyph: '🌡️', frag: `hotter than ${tmaxPct}% of` };
  if (tmaxPct <= 1) return { label: 'extreme cold for the date', glyph: '🧊', frag: 'colder than 99% of' };
  if (tmaxPct <= 10) return { label: 'unusually cool', glyph: '❄️', frag: `colder than ${100 - tmaxPct}% of` };
  if (tminPct >= 95) return { label: 'unusually warm night', glyph: '🌙', frag: `overnight low warmer than ${tminPct}% of` };
  return { label: 'normal for the date', glyph: '✓', frag: '' };
}

/**
 * The question, answered: how unusual is this forecast high/low for this place and date?
 * `date` is the forecast day's ISO date; values in °C (the app's data unit).
 */
export async function isThisWeird(
  loc: SavedLocation,
  date: string,
  forecastTmaxC: number,
  forecastTminC: number,
): Promise<Weirdness> {
  const clim = await loadOrFetch(loc);
  const targetMd = Number(date.slice(5, 7)) * 100 + Number(date.slice(8, 10));

  const poolMax: number[] = [];
  const poolMin: number[] = [];
  for (let i = 0; i < clim.monthDay.length; i++) {
    if (mdDistance(clim.monthDay[i]!, targetMd) <= WINDOW_DAYS) {
      poolMax.push(clim.tmax[i]!);
      poolMin.push(clim.tmin[i]!);
    }
  }
  if (poolMax.length < 100) throw new Error(`climatology pool too small (${poolMax.length})`);

  const tmaxPct = percentile(forecastTmaxC, poolMax);
  const tminPct = percentile(forecastTminC, poolMin);
  const t = tier(tmaxPct, tminPct);
  const years = `${START.slice(0, 4)}–${END.slice(0, 4)}`;

  const monthDayHuman = new Date(`${date}T12:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const sentence = t.frag
    ? `${t.frag} ${monthDayHuman}±${WINDOW_DAYS}d days here since 1940 (ERA5, n=${poolMax.length})`
    : `typical for ${monthDayHuman} here (p${tmaxPct} of ${years}, n=${poolMax.length})`;

  return { tmaxPct, tminPct, n: poolMax.length, years, label: t.label, glyph: t.glyph, sentence };
}
