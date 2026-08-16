/**
 * Aether — permanently excluded data sources.
 *
 * These are NOT "not yet integrated". Each one was evaluated during the research phase and
 * ruled out for a licensing or access reason that does not expire. The layer registry checks
 * this list, so a future contribution cannot wire one in by accident — which is the entire
 * point of writing it down on commit #1 rather than remembering it.
 *
 * See ACTION_PLAN.md §5 and proposal §3.3.
 */

export interface DeniedSource {
  id: string;
  name: string;
  /** Why it is excluded — the durable reason, not a snapshot of availability. */
  reason: string;
  /** What to use instead, where an alternative exists. */
  useInstead: string | null;
}

export const DENYLIST: readonly DeniedSource[] = [
  {
    id: 'blitzortung',
    name: 'Blitzortung lightning network',
    reason:
      'Contributor-gated. Requires explicit permission and operating a detector; carries an ' +
      'explicit "no yet-another-visualization" rule.',
    useInstead: 'GOES GLM LCFA flash points from anonymous S3 (public domain)',
  },
  {
    id: 'mping',
    name: 'mPING (NSSL crowdsourced reports)',
    reason:
      'API is gated behind an approved research or commercial licence application; the ' +
      'research licence forbids redistribution.',
    useInstead: null,
  },
  {
    id: 'purpleair',
    name: 'PurpleAir',
    reason: 'Moved to paid points-based billing in November 2023 — no longer effectively free.',
    useInstead: 'Sensor.Community',
  },
  {
    id: 'wwlln',
    name: 'WWLLN',
    reason: 'Funded entirely by data sales; stroke data is not free.',
    useInstead: 'GOES GLM',
  },
  {
    id: 'emaddc-modes',
    name: 'EMADDC / Mode-S aircraft-derived weather',
    reason:
      'Real data (25M obs/day, ECMWF-assimilated) but licensed to national met services only. ' +
      'A licensing trap, not an availability problem.',
    useInstead: 'DIY RTL-SDR reception only (see Sky Traffic, deferred)',
  },
  {
    id: 'space-track-raw',
    name: 'space-track.org raw catalogue reposting',
    reason:
      'US Gov data-use agreement prohibits bulk redistribution of the raw catalogue. ' +
      'Derived products only.',
    useInstead: 'CelesTrak GP element sets',
  },
  {
    id: 'aurorasaurus-live',
    name: 'Aurorasaurus as a live source',
    reason: 'No live API exists — only a map UI and a Zenodo archive dump.',
    useInstead: 'NOAA OVATION',
  },
  {
    id: 'haarp-instruments',
    name: 'HAARP public instrument endpoints',
    reason:
      'Endpoints are stale — 2026-08 probes failed to establish a TCP connection, and the ' +
      'cited CGIs date to ~2010. Building on them would be building on a myth twice over.',
    useInstead: 'GIRO/DIDBase digisondes, KC2G foF2 maps, SuperDARN',
  },
  {
    id: 'windy-scrape',
    name: 'Scraping Windy.com or Ventusky tiles',
    reason:
      'Their model data is licensed to them, not to downstream scrapers. Community norm and ' +
      'a straightforward ToS violation.',
    useInstead: 'Render from NOMADS / ECMWF open data directly (Tier B)',
  },
] as const;

const DENIED_IDS = new Set(DENYLIST.map((d) => d.id));

/** Throws if a layer registration references an excluded source. Call it at registration time. */
export function assertNotDenied(sourceId: string): void {
  if (DENIED_IDS.has(sourceId)) {
    const entry = DENYLIST.find((d) => d.id === sourceId)!;
    throw new Error(
      `Data source "${sourceId}" is on the Aether denylist.\n  Reason: ${entry.reason}` +
        (entry.useInstead ? `\n  Use instead: ${entry.useInstead}` : ''),
    );
  }
}
