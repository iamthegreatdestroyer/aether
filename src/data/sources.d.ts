/**
 * Types for the data-source contract in `sources.mjs`.
 *
 * The contract itself is plain ESM so that `scripts/probe-sources.mjs` can import it with no
 * build step and no dependencies. These declarations give the app full type-checking anyway.
 */

/**
 * 'A'        — direct keyless call from the browser; CORS-open, first-hand verified.
 * 'A-native' — direct in Tauri native builds; needs the Cloudflare Worker proxy in the PWA.
 * 'B'        — server-side only (GRIB / bulk); never called from the client.
 */
export type Tier = 'A' | 'A-native' | 'B';

/** First-hand measurement of the `Access-Control-Allow-Origin` response header. */
export type CorsState = 'open' | 'none';

export interface Source {
  /** Stable key used everywhere in the app. Never rename — it appears in the ledger. */
  id: string;
  name: string;
  /** What this source is for, in product terms. */
  role: string;
  /** Cheap, representative request used by the CI probe. */
  probeUrl: string;
  tier: Tier;
  cors: CorsState;
  /** Response codes that mean "healthy". 429 counts as healthy-but-throttled for ECMWF. */
  expectStatus: number[];
  /**
   * Minimum plausible response size. Guards against the 200-with-an-error-body failure mode:
   * SondeHub returns HTTP 200 and the text "Duration must be either ..." for a malformed
   * `duration`, which a status-only probe reports as healthy. Learned the hard way.
   */
  minBytes?: number;
  /** Substring that must NOT appear in the body — a second guard against soft failures. */
  mustNotContain?: string;
  license: string;
  /** Exact string that must be displayed. `null` = no attribution legally required. */
  attribution: string | null;
  attributionUrl?: string;
  /** Documented limits — enforced centrally by the fetch scheduler, not per call site. */
  rateLimit: string;
  notes: string;
  /** ISO date of the last first-hand verification of status + CORS. */
  verifiedAt: string;
}

export declare const SOURCES: Source[];
export declare const TIER_A: Source[];
export declare const NEEDS_PROXY: Source[];
export declare function source(id: string): Source;
export declare function requiredAttributions(): Array<{
  id: string;
  name: string;
  text: string;
  url: string | null;
  license: string;
}>;
