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

const MIN_INTERVAL_MS: Record<string, number> = {
  'open-meteo': 1_000,
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

export async function fetchJson<T>(sourceId: string, url: string): Promise<T> {
  // In-flight dedupe first: identical concurrent requests collapse to one.
  const existing = inflight.get(url);
  if (existing) return existing as Promise<T>;

  const p = (async (): Promise<T> => {
    // Politeness: take the next slot in this source's serialised queue.
    await reserveSlot(sourceId, MIN_INTERVAL_MS[sourceId] ?? 1_000);

    let lastError: FetchError | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (res.ok) return (await res.json()) as T;
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
