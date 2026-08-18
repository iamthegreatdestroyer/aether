/**
 * Central fetch scheduler — the single enforcement point for rate-limit etiquette.
 *
 * The plan's compliance checklist (§5) requires this to exist as one module rather than
 * per-call-site politeness, for a structural reason: every quota in the free stack is
 * etiquette, and etiquette scattered across call sites decays. Open-Meteo allows 10k/day —
 * a personal app at three locations uses a fraction of a percent of that — but the scheduler
 * is the place where that stays true when someone adds a layer in P4.
 *
 * What it enforces:
 *   - per-source minimum interval between requests
 *   - in-flight dedupe (two cards asking for the same URL share one request)
 *   - exponential backoff on 429/5xx — the ECMWF 429 in the endpoint probe (ACTION_PLAN §0.3)
 *     is proof these limits are enforced and reachable, not theoretical
 */

import { source } from './sources.mjs';

const MIN_INTERVAL_MS: Record<string, number> = {
  'open-meteo': 1_000,
  // Index JSON only — the tiles themselves are loaded by MapLibre, not through here.
  librewxr: 2_000,
  rainviewer: 2_000, // their hard cap is 100 req/IP/min; one index call is nothing
  'iem-nexrad': 2_000,
  aviationweather: 2_000, // native-only METARs; one bbox call per location per refresh
  // Keyed area queries: quota is 5000 transactions/10 min — 350 ms keeps us ~1/6th of it
  // even if every saved location queries all three VIIRS satellites at once.
  'firms-api': 350,
  'noaa-coops': 500, // two calls per location (predictions + observed) on panel open
  'open-meteo-marine': 1_000,
  'adsb-lol': 3_000, // volunteer network: one viewport query per poll, never a sweep
  adsbdb: 1_000,
  'nws-alerts': 1_000,
  overpass: 3_000, // shared volunteer instance — be a good guest
  'usgs-3dep': 1_000,
  planespotters: 1_000, // one lookup per click, cached per registration
};

const RETRY_DELAYS_MS = [1_000, 4_000, 16_000];

const inflight = new Map<string, Promise<unknown>>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Per-source politeness as a promise chain, not a timestamp check.
 *
 * The first version read a shared `lastRequestAt` timestamp: concurrent callers all computed
 * their wait against the same stale value, slept the same duration, and woke simultaneously —
 * three "staggered" requests collapsed into two waves. A chain serialises them properly:
 * each caller's slot is "previous slot, then the interval".
 */
const politeness = new Map<string, Promise<void>>();

function reserveSlot(sourceId: string, minIntervalMs: number): Promise<void> {
  const prev = politeness.get(sourceId) ?? Promise.resolve();
  const slot = prev.then(() => sleep(minIntervalMs));
  // The chain must survive a rejected fetch — politeness is unconditional.
  politeness.set(sourceId, slot.catch(() => {}));
  return prev;
}

export class FetchError extends Error {
  constructor(
    readonly url: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Dev outage simulation. `__aether.block(['librewxr'])` persists a blocklist that makes
 * fetchJson fail for those sources at the network layer — which is the honest way to
 * exercise the radar failover chain (the P2 exit test): the provider's real error path runs,
 * not a mock of it. Empty in normal use; survives reload so the chain's cold-boot behaviour
 * under outage is testable too.
 */
const BLOCK_KEY = 'aether.blockSources';

export function blockedSources(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(BLOCK_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function setBlockedSources(ids: string[]): void {
  localStorage.setItem(BLOCK_KEY, JSON.stringify(ids));
}

/**
 * Native transport (P6). Under Tauri, tauri-plugin-http performs requests from the RUST
 * side, immune to webview CORS — which is precisely what the contract's `A-native` tier has
 * been waiting for since day one (GFZ official Kp; aviationweather METARs next). In the
 * plain PWA this stays null and A-native sources keep throwing their honest error.
 */
let nativeFetch: typeof fetch | null = null;

export async function initNativeTransport(): Promise<boolean> {
  if (!('__TAURI_INTERNALS__' in window)) return false;
  try {
    const m = await import('@tauri-apps/plugin-http');
    nativeFetch = m.fetch as typeof fetch;
    return true;
  } catch {
    return false;
  }
}

export function hasNativeTransport(): boolean {
  return nativeFetch !== null;
}

/** fetchJson's sibling for CSV/text lanes — same scheduler, dedupe, and backoff. */
export async function fetchText(sourceId: string, url: string): Promise<string> {
  return fetchBody(sourceId, url, (r) => r.text());
}

export async function fetchJson<T>(sourceId: string, url: string): Promise<T> {
  return fetchBody(sourceId, url, (r) => r.json() as Promise<T>);
}

async function fetchBody<T>(
  sourceId: string,
  url: string,
  read: (r: Response) => Promise<T>,
): Promise<T> {
  if (blockedSources().has(sourceId)) {
    throw new FetchError(url, null, `${sourceId} blocked (dev outage simulation)`);
  }
  // In-flight dedupe first: identical concurrent requests collapse to one.
  const existing = inflight.get(url);
  if (existing) return existing as Promise<T>;

  const p = (async (): Promise<T> => {
    // Politeness: take the next slot in this source's serialised queue.
    await reserveSlot(sourceId, MIN_INTERVAL_MS[sourceId] ?? 1_000);

    let lastError: FetchError | null = null;
    // Use the MINIMUM mechanism that works. The native transport exists for sources the
    // browser is refused by (tier 'A-native'); routing CORS-open sources through Rust as
    // well gains nothing and costs something real — it was the mechanism behind the P6
    // capability bug, and it changes the User-Agent, which planespotters.net answers 403 to
    // (found 2026-08-18). Browser fetch for anything the browser can already reach.
    const tier = (() => {
      try {
        return source(sourceId).tier;
      } catch {
        return null; // not a contract source (same-origin artifact) — browser fetch is right
      }
    })();
    const doFetch = tier === 'A-native' && nativeFetch ? nativeFetch : fetch;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const res = await doFetch(url, { headers: { Accept: 'application/json' } });
        if (res.ok) return await read(res);
        lastError = new FetchError(url, res.status, `${sourceId} answered ${res.status}`);
        // Only throttling and server errors are worth retrying; a 4xx is our bug.
        if (res.status !== 429 && res.status < 500) throw lastError;
      } catch (err) {
        lastError =
          err instanceof FetchError ? err : new FetchError(url, null, String(err));
        if (lastError.status !== null && lastError.status !== 429 && lastError.status < 500) {
          throw lastError;
        }
      }
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await sleep(delay);
    }
    throw lastError ?? new FetchError(url, null, `${sourceId} failed`);
  })();

  inflight.set(url, p);
  try {
    return await p;
  } finally {
    inflight.delete(url);
  }
}
