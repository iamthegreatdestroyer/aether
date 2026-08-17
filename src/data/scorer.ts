/**
 * The T+1 scorer — where receipts meet reality.
 *
 * For every logged forecast, every model, every valid hour that has since PASSED and has a
 * stored observation: error = forecast − observed. Scores are keyed deterministically
 * (`entry|model|hour`), so rescoring is a no-op overwrite — idempotent by construction, the
 * same property the endpoint probe and the attribution generator have.
 *
 * What this deliberately is NOT: a skill score against climatology, or significance testing.
 * At day one there are three scored hours; pretending statistical authority would be the
 * exact dishonesty this feature exists to fight. The UI states the sample size and lets MAE
 * be MAE. The proposal's bar — "after 30 days, a statistically meaningful ranking" — is met
 * by accumulation, not cleverness.
 */

import { STORE_SCORES, dbEntries, dbGetAllByIndex, dbPut } from './db';
import { loadObservations } from './observations';
import type { Observation } from './observations';
import { LEDGER_MODELS, MODEL_LABELS } from './ledger';
import type { ForecastLogEntry, ModelSeries } from './ledger';

export interface Score {
  locationKey: string;
  model: string;
  /** ISO UTC hour scored. */
  hour: string;
  /** Hours between fetch and validity — the lead. */
  leadHours: number;
  forecastC: number;
  observedC: number;
  /** Signed: positive = model ran warm. */
  errorC: number;
  provider: Observation['provider'];
}

/** Lead buckets for the leaderboard. Day-1 (0–24 h) is the headline ranking. */
export const LEAD_BUCKETS = [
  { id: 'h0_24', label: '0–24 h', min: 0, max: 24 },
  { id: 'h24_72', label: '1–3 d', min: 24, max: 72 },
  { id: 'h72plus', label: '3 d +', min: 72, max: 168 },
] as const;

function entrySeries(entry: ForecastLogEntry): Record<string, ModelSeries> {
  // v2 entries only. The v1 (P0-era) format logged times in the location's LOCAL zone
  // (timezone=auto) with no offset marker — treating them as UTC would shift New York by
  // 4 h and Tokyo by 9, poisoning every score with a systematic offset that LOOKS like
  // model bias. Silently-wrong receipts are worse than absent ones; the UTC v2 stream
  // replaces them within the hour, and the v1 rows stay in the append-only log untouched.
  return entry.models ?? {};
}

/** Normalise Open-Meteo's zoneless "2026-08-17T03:00" to the obs store's "…T03:00Z" shape. */
function toUtcHourKey(t: string): string {
  return t.length === 16 ? `${t}:00Z`.replace(':00:00Z', ':00Z') : t;
}

export async function runScorer(): Promise<{ scored: number; locations: string[] }> {
  const entries = await dbEntries<ForecastLogEntry>('forecast_log');
  const now = Date.now();
  const touched = new Set<string>();
  let scored = 0;

  // Observations per location, loaded once.
  const obsByLoc = new Map<string, Map<string, Observation>>();
  for (const lk of new Set(entries.map((e) => e.value.locationKey))) {
    const map = new Map<string, Observation>();
    for (const o of await loadObservations(lk)) map.set(o.hour, o);
    obsByLoc.set(lk, map);
  }

  for (const { key, value: entry } of entries) {
    const obs = obsByLoc.get(entry.locationKey);
    if (!obs || obs.size === 0) continue;

    for (const [model, series] of Object.entries(entrySeries(entry))) {
      for (let i = 0; i < series.time.length; i++) {
        const t = series.time[i];
        const fc = series.temperature_2m[i];
        if (t === undefined || fc === null || fc === undefined) continue;
        const hourKey = toUtcHourKey(t);
        const validMs = Date.parse(hourKey);
        if (Number.isNaN(validMs) || validMs > now) continue;
        // Lead < 0 would mean "forecast" hours already past at fetch time — history padding,
        // not prediction. Scoring them would flatter every model.
        const leadHours = (validMs - entry.fetchedAt) / 3_600_000;
        if (leadHours < 0) continue;

        const o = obs.get(hourKey.slice(0, 13) + ':00Z');
        if (!o) continue;

        const score: Score = {
          locationKey: entry.locationKey,
          model,
          hour: hourKey,
          leadHours: Math.round(leadHours * 10) / 10,
          forecastC: fc,
          observedC: o.temperatureC,
          errorC: Math.round((fc - o.temperatureC) * 100) / 100,
          provider: o.provider,
        };
        await dbPut(STORE_SCORES, score, `${String(key)}|${model}|${hourKey}`);
        scored++;
        touched.add(entry.locationKey);
      }
    }
  }
  return { scored, locations: [...touched] };
}

// ------------------------------------------------------------------ summaries

export interface ModelSummary {
  model: string;
  label: string;
  n: number;
  maeC: number;
  /** Mean signed error — the transparent bias the Personal Nowcast will correct with. */
  biasC: number;
}

export interface LocationSummary {
  locationKey: string;
  buckets: Array<{ bucket: (typeof LEAD_BUCKETS)[number]; models: ModelSummary[] }>;
  totalScores: number;
}

export async function summarize(lk: string): Promise<LocationSummary> {
  const scores = await dbGetAllByIndex<Score>(STORE_SCORES, 'by_location', lk);
  const buckets = LEAD_BUCKETS.map((bucket) => {
    const inBucket = scores.filter((s) => s.leadHours >= bucket.min && s.leadHours < bucket.max);
    const models = LEDGER_MODELS.map((model) => {
      const ms = inBucket.filter((s) => s.model === model);
      const n = ms.length;
      return {
        model,
        label: MODEL_LABELS[model] ?? model,
        n,
        maeC: n ? +(ms.reduce((a, s) => a + Math.abs(s.errorC), 0) / n).toFixed(2) : NaN,
        biasC: n ? +(ms.reduce((a, s) => a + s.errorC, 0) / n).toFixed(2) : NaN,
      };
    }).filter((m) => m.n > 0);
    models.sort((a, b) => a.maeC - b.maeC);
    return { bucket, models };
  });
  return { locationKey: lk, buckets, totalScores: scores.length };
}
