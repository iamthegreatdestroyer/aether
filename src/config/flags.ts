/**
 * Aether — feature flags.
 *
 * The only flag that genuinely matters here is NONCOMMERCIAL_SOURCES.
 *
 * Roughly a quarter of the esoteric data catalog is non-commercial-gated: fully legal for a
 * personal app, categorically incompatible with any future monetization. Isolating those
 * sources behind ONE flag on commit #1 is a five-line decision now versus a licensing crisis
 * later. If Aether ever monetizes, this flips to false and the offending layers disappear —
 * no archaeology required.
 *
 * See ACTION_PLAN.md §1(5) and proposal §5.3.2 (last row of Table 5.2).
 */

export const FLAGS = {
  /**
   * Gates every source whose licence forbids commercial use.
   * MUST be false in any build that is sold, ad-supported, or otherwise monetized.
   */
  NONCOMMERCIAL_SOURCES: true,

  /** Tier B pipeline (GitHub Actions cron -> PNG data textures -> Pages/R2). Lands at P1. */
  TIER_B_PIPELINE: false,

  /** Cloudflare Worker CORS proxy for gfz-kp and aviationweather.gov in the PWA build. */
  WORKER_PROXY: false,

  /** Mesh bridge (Proposal 2). Stays false until Aether P3 ships — see ACTION_PLAN.md §7. */
  MESH_BRIDGE: false,
} as const;

/**
 * Sources gated by NONCOMMERCIAL_SOURCES.
 * Every entry here is personal-use-legal and commercial-use-prohibited.
 */
export const NONCOMMERCIAL_SOURCE_IDS: readonly string[] = [
  'wspr-live', // non-commercial only; results must remain free
  'superdarn', // non-commercial, no defence use; PI acknowledgement
  'intermagnet', // CC BY-NC 4.0
  'nmdb', // non-commercial; commercial needs PI permission
] as const;

/** True if a source may be used in the current build configuration. */
export function isSourcePermitted(sourceId: string): boolean {
  if (NONCOMMERCIAL_SOURCE_IDS.includes(sourceId)) {
    return FLAGS.NONCOMMERCIAL_SOURCES;
  }
  return true;
}
