/**
 * The Personal Nowcast — a forecast corrected by its own track record at YOUR station.
 *
 * This is what the whole verification apparatus was built to enable, and the scorer has said
 * so since P3: `biasC` is documented there as "the transparent bias the Personal Nowcast will
 * correct with". Every forecast the app displays was logged when fetched and scored against a
 * real observation once the hour passed. Given enough of those receipts, the models' habit at
 * one point becomes measurable — and a measured habit is correctable.
 *
 * Measured at this desk on 2026-08-19, KSRQ (Sarasota), 0–24 h lead: every model ran COLD,
 * by 2–4 °F, on every scored hour. Mean absolute error equalled absolute bias exactly, which
 * is the signature of a one-directional error rather than scatter.
 *
 * THREE RULES, because a "corrected" number that is wrong is worse than an honest raw one:
 *
 *  1. **Never replace the forecast.** The raw number stays; the correction appears beside it,
 *     labelled, with its evidence. The app's claim has always been that it shows its work.
 *  2. **Never correct noise.** A bias must be statistically distinguishable from zero —
 *     |bias| > 2 × standard error — before it is applied at all. A model that is merely
 *     scattered around the truth has no habit to correct, and pretending otherwise would
 *     manufacture confidence out of a small sample.
 *  3. **Never correct from a thin record.** Below MIN_SAMPLE scored hours there is no claim
 *     to make, and the UI says "still gathering" rather than inventing one.
 */

import { STORE_SCORES, dbGetAllByIndex } from './db';
import type { Score } from './scorer';

/** The model the forecast cards actually display (Open-Meteo's blended default). */
const DISPLAY_MODEL = 'best_match';

/** Below this, there is no claim to make. ~4 days of hourly receipts at one location. */
const MIN_SAMPLE = 100;

/** Current conditions are a zero-ish lead; correcting them with a 3-day bias would be wrong. */
const MAX_LEAD_HOURS = 24;

export interface BiasCorrection {
  /** Scored hours behind the estimate. */
  n: number;
  /** Signed mean error in °C. Positive = the model ran WARM, so the correction subtracts. */
  biasC: number;
  /** Standard error of that mean, in °C. */
  stdErrC: number;
  /** True when |bias| exceeds 2 standard errors — a habit, not scatter. */
  significant: boolean;
  /** Which observation source the truth came from, for the provenance line. */
  station: string | null;
}

export type NowcastState =
  | { kind: 'gathering'; n: number }
  | { kind: 'no-bias'; n: number; biasC: number }
  | { kind: 'corrected'; correctedC: number; correction: BiasCorrection };

/**
 * The display model's measured bias at one location over short leads. Returns null when the
 * ledger has nothing to say yet — a normal answer on a fresh install, not a failure.
 */
export async function measuredBias(locationKey: string): Promise<BiasCorrection | null> {
  const all = await dbGetAllByIndex<Score>(STORE_SCORES, 'by_location', locationKey);
  const rows = all.filter(
    (s) => s.model === DISPLAY_MODEL && s.leadHours >= 0 && s.leadHours < MAX_LEAD_HOURS,
  );
  const n = rows.length;
  if (n === 0) return null;

  const mean = rows.reduce((a, s) => a + s.errorC, 0) / n;
  // Sample standard deviation, then the standard error of the mean. With n < 2 there is no
  // spread to speak of, so the estimate cannot be significant by definition.
  const variance =
    n > 1 ? rows.reduce((a, s) => a + (s.errorC - mean) ** 2, 0) / (n - 1) : Number.POSITIVE_INFINITY;
  const stdErr = Math.sqrt(variance / n);

  return {
    n,
    biasC: +mean.toFixed(3),
    stdErrC: +stdErr.toFixed(3),
    significant: n >= MIN_SAMPLE && Math.abs(mean) > 2 * stdErr,
    station: rows[rows.length - 1]?.provider ?? null,
  };
}

/**
 * What to show beside the current temperature. Every branch is a real answer the UI can
 * state plainly — including "the models have no measurable habit here", which is itself
 * worth knowing and is what a well-calibrated forecast looks like.
 */
export async function personalNowcast(
  locationKey: string,
  rawC: number,
): Promise<NowcastState | null> {
  const b = await measuredBias(locationKey);
  if (!b) return null;
  if (b.n < MIN_SAMPLE) return { kind: 'gathering', n: b.n };
  if (!b.significant) return { kind: 'no-bias', n: b.n, biasC: b.biasC };
  // errorC is forecast − observed, so a warm-running model (positive bias) is corrected down.
  return { kind: 'corrected', correctedC: rawC - b.biasC, correction: b };
}
