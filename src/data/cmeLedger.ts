/**
 * CME track record — how NASA's WSA-Enlil arrival predictions have actually fared.
 *
 * Baked by CI (scripts/build_cme_ledger.py) and read same-origin, like the storm ledger. The
 * scoring rule and its limits live in that script; this file only loads and words the result.
 * The wording is the product here: a track record built on a handful of events is easy to
 * oversell, so the sentence refuses to quote a hit rate below `summary.enough`.
 */

export interface CmeLedgerRow {
  cme: string;
  issued: string;
  predicted: string;
  kpLow: number | null;
  kpHigh: number | null;
  runs: number;
  status: 'pending' | 'confirmed' | 'unconfirmed';
  observed?: string;
  /** hours; positive = the shock arrived LATER than predicted */
  errorH?: number;
  observedKp?: number | null;
}

export interface CmeLedger {
  builtAt: string;
  source: string;
  historyDays: number;
  summary: {
    predictions: number;
    scored: number;
    pending: number;
    confirmed: number;
    unconfirmed: number;
    confirmedPct: number | null;
    arrival: {
      n: number;
      medianErrorH: number | null;
      meanAbsErrorH: number | null;
      within6hPct: number | null;
      within12hPct: number | null;
    };
    kp: { n: number; stormExceededRange: number };
    enough: boolean;
    caveat: string;
  };
  recent: CmeLedgerRow[];
}

export async function loadCmeLedger(): Promise<CmeLedger | null> {
  try {
    const r = await fetch('data/space/cme_ledger.json');
    if (!r.ok) return null;
    const doc = (await r.json()) as CmeLedger;
    return doc && doc.summary && Array.isArray(doc.recent) ? doc : null;
  } catch {
    return null;
  }
}

/** The headline sentences, or null when there is nothing honest to say. */
export function cmeLedgerSentences(l: CmeLedger): string[] {
  const s = l.summary;
  const a = s.arrival;
  const out: string[] = [];
  if (a.n === 0 || a.meanAbsErrorH === null) return out;

  if (!s.enough) {
    out.push(
      `Only ${s.confirmed} Earth-directed CME${s.confirmed === 1 ? '' : 's'} confirmed in the last ` +
        `${l.historyDays} days — too few to quote a rate yet.`,
    );
    return out;
  }

  const early = (a.medianErrorH ?? 0) < -1;
  const late = (a.medianErrorH ?? 0) > 1;
  out.push(
    `Of ${s.confirmed} predicted CMEs whose shock a forecaster confirmed over ${l.historyDays} days, ` +
      `the arrival time was off by ${a.meanAbsErrorH} h on average — within 6 h ${a.within6hPct}% of ` +
      `the time, within 12 h ${a.within12hPct}%.` +
      (early ? ` They tended to arrive EARLY (median ${Math.abs(a.medianErrorH!)} h ahead of the forecast).` : '') +
      (late ? ` They tended to arrive LATE (median ${a.medianErrorH} h behind the forecast).` : ''),
  );
  if (s.kp.n > 0) {
    out.push(
      `Intensity: in ${s.kp.stormExceededRange} of ${s.kp.n} CMEs that produced a recorded storm, the ` +
        `storm's peak Kp topped the model's range` +
        (s.kp.n < 10 ? ` (small sample, and only storms that happened are counted).` : `.`),
    );
  }
  return out;
}
