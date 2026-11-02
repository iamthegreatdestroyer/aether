/**
 * Trails — the AllTrails/Gaia strike.
 *
 * Those apps charge $36–40/yr, and the map data under them is OpenStreetMap plus public
 * elevation. Measured 2026-08-18: Overpass answers `Access-Control-Allow-Origin: *` (134
 * trail ways in one small Sarasota box) and the USGS 3DEP point service does too — so unlike
 * flight, this whole lane works in the browser, on the phone, with no key.
 *
 * What is deliberately NOT claimed: their real moat is **offline** map packs, and this is
 * not that. Recorded in the plan as the PMTiles path rather than pretended here.
 *
 * What Aether adds that a trail app does not have: the weather side. A trail listing that
 * knows the wind, the heat index and whether a warning is in force where the trail actually
 * is — that is the fusion this app was built for, and the route sampler already speaks it.
 */

import { FetchError, fetchJson } from './fetcher';
import { STORE_LATEST, dbGet, dbPut } from './db';
import { source } from './sources.mjs';
import { haversineKm } from './geo';
import type { SavedLocation } from '../ui/locations';

export interface Trail {
  id: number;
  name: string;
  /** OSM highway class: path, footway, track, cycleway, bridleway. */
  kind: string;
  surface: string | null;
  /** Metres, summed along the way's own geometry. */
  lengthM: number;
  /** Midpoint, for distance-from-you and for weather sampling. */
  lat: number;
  lon: number;
  distanceKm: number;
  /** True when OSM marks it wheelchair-accessible — rarely tagged, never inferred. */
  wheelchair: boolean | null;
}

interface OverpassWay {
  type: 'way';
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

const TRAIL_KINDS = ['path', 'footway', 'track', 'bridleway', 'cycleway'];

function wayLengthM(geom: Array<{ lat: number; lon: number }>): number {
  let m = 0;
  for (let i = 1; i < geom.length; i++) {
    m += haversineKm(geom[i - 1]!.lat, geom[i - 1]!.lon, geom[i]!.lat, geom[i]!.lon) * 1000;
  }
  return Math.round(m);
}

/**
 * Named trails within `radiusKm`. Unnamed ways are excluded on purpose: OSM is full of
 * desire lines and driveway spurs tagged `path`, and a list of "unnamed path, 40 m" is
 * noise, not a trail guide.
 */
export async function fetchTrails(loc: SavedLocation, radiusKm = 15): Promise<Trail[]> {
  const r = Math.round(radiusKm * 1000);
  const q =
    `[out:json][timeout:25];` +
    `way(around:${r},${loc.lat.toFixed(4)},${loc.lon.toFixed(4)})` +
    `["highway"~"^(${TRAIL_KINDS.join('|')})$"]["name"];` +
    `out geom tags;`;
  const d = await fetchJson<{ elements?: OverpassWay[]; remark?: string }>(
    'overpass',
    `${source('overpass').baseUrl}?data=${encodeURIComponent(q)}`,
  );
  // Overpass answers an overloaded or timed-out query with HTTP 200, a `remark`, and ZERO
  // elements, which looks exactly like "no trails here". Reported as a lookup failure instead,
  // because an empty list shown (and cached) as a fact would be a confident wrong answer.
  if (d.remark && /runtime error|timed out|out of memory|too busy/i.test(d.remark)) {
    throw new FetchError(source('overpass').baseUrl!, null, `overpass remark: ${d.remark}`);
  }

  const byName = new Map<string, Trail>();
  for (const w of d.elements ?? []) {
    const g = w.geometry;
    const name = w.tags?.['name'];
    if (!g || g.length < 2 || !name) continue;
    const mid = g[Math.floor(g.length / 2)]!;
    const len = wayLengthM(g);
    // Key on a normalised name: OSM has "Flo's trail" and "Flo's Trail" as separate ways
    // (seen live at Home), and listing one trail twice because a mapper shifted the caps is
    // exactly the kind of noise that makes a generated list feel untrustworthy.
    const key = name.toLowerCase().replace(/\s+/g, ' ').trim();
    const existing = byName.get(key);
    if (existing) {
      // OSM splits a single trail into many ways at every tag change; a hiker thinks of it
      // as one trail, so segments sharing a name are summed rather than listed separately.
      existing.lengthM += len;
      // Keep the longest segment's surface tag rather than whichever came first.
      if (len > existing.lengthM / 2 && w.tags?.['surface']) existing.surface = w.tags['surface'];
      continue;
    }
    byName.set(key, {
      id: w.id,
      name,
      kind: w.tags?.['highway'] ?? 'path',
      surface: w.tags?.['surface'] ?? null,
      lengthM: len,
      lat: mid.lat,
      lon: mid.lon,
      distanceKm: Math.round(haversineKm(loc.lat, loc.lon, mid.lat, mid.lon) * 10) / 10,
      wheelchair:
        w.tags?.['wheelchair'] === 'yes' ? true : w.tags?.['wheelchair'] === 'no' ? false : null,
    });
  }

  return [...byName.values()]
    .filter((t) => t.lengthM >= 150) // a 40 m stub is a connector, not a trail
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/** Elevation in metres at a point, from USGS 3DEP. US-only by definition of the dataset. */
export async function fetchElevationM(lat: number, lon: number): Promise<number | null> {
  try {
    const u = `${source('usgs-3dep').baseUrl}?x=${lon.toFixed(5)}&y=${lat.toFixed(5)}&units=Meters&wkid=4326&includeDate=false`;
    const d = await fetchJson<{ value?: number | string; location?: unknown }>('usgs-3dep', u);
    const v = typeof d.value === 'string' ? Number(d.value) : d.value;
    // 3DEP returns a large negative sentinel for "outside coverage" — that is a no, not a depth.
    return typeof v === 'number' && Number.isFinite(v) && v > -1000 ? Math.round(v) : null;
  } catch {
    return null;
  }
}

export function trailKindGlyph(kind: string): string {
  return (
    { path: '🥾', footway: '🚶', track: '🛤', bridleway: '🐎', cycleway: '🚲' }[kind] ?? '🥾'
  );
}

export function lengthLabel(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}

// ------------------------------------------------------------------ cache + busy handling

/**
 * The Trails lookup rides the shared, free Overpass API, which measured 2026-11-02 answers in
 * 33-42 s when it answers at all, and was the only red line in the daily endpoint audit for 12
 * straight days (HTTP 502 and timeouts). OSM trails do not change by the hour, so the geometry
 * is cached per place; live weather, alerts and elevation are NOT cached.
 */
const TRAILS_TTL_MS = 24 * 3_600_000;
/** An empty answer might be a real "nothing mapped here" or a hiccup: re-ask sooner. */
const TRAILS_EMPTY_TTL_MS = 2 * 3_600_000;
/** After a failed refresh, an older list still beats an error, up to this age. */
const TRAILS_STALE_MAX_MS = 30 * 24 * 3_600_000;
const TRAILS_DEADLINE_MS = 55_000;

export interface TrailsResult {
  trails: Trail[];
  /** When the list was fetched from OpenStreetMap (ms). */
  fetchedAt: number;
  /** live = just fetched; cache = fresh enough, not re-asked; stale = refresh failed, old list shown. */
  origin: 'live' | 'cache' | 'stale';
}

export class TrailsBusyError extends Error {
  constructor() {
    super(
      "OpenStreetMap's free trail server is busy right now (it is a shared community service). " +
        'Nothing is wrong on your side - try again in a minute.',
    );
  }
}

interface CacheEntry {
  fetchedAt: number;
  trails: Trail[];
}

export const trailsCacheKey = (loc: { lat: number; lon: number }, radiusKm: number) =>
  `trails|${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}|${radiusKm}`;

/** Server-side trouble and network failure are "busy"; a 4xx is OUR bug and stays visible. */
export function isBusyError(err: unknown): boolean {
  if (err instanceof TrailsBusyError) return true;
  if (err instanceof FetchError) return err.status === null || err.status === 429 || err.status >= 500;
  return false;
}

/** Distances are relative to wherever you are looking from, so they are never cached. */
function withDistances(trails: Trail[], loc: { lat: number; lon: number }): Trail[] {
  return trails
    .map((t) => ({ ...t, distanceKm: Math.round(haversineKm(loc.lat, loc.lon, t.lat, t.lon) * 10) / 10 }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/**
 * Cache-first trail lookup. Pure in its dependencies (cache I/O, the live call, the clock) so
 * the policy can be tested without a browser:
 *   fresh cache -> return it, no network;  else ask Overpass, racing a deadline;
 *   success -> store + return;  failure -> the old list if any exists, else a plain "busy" error.
 * A live call that loses the deadline race keeps running and still fills the cache when it
 * lands, so the NEXT open is instant instead of paying the same 40 s again.
 */
export async function resolveTrails(
  deps: {
    read: () => Promise<CacheEntry | undefined>;
    write: (e: CacheEntry) => Promise<unknown>;
    live: () => Promise<Trail[]>;
    now: () => number;
    deadlineMs: number;
  },
  loc: { lat: number; lon: number },
): Promise<TrailsResult> {
  const cached = await deps.read().catch(() => undefined);
  const age = cached ? deps.now() - cached.fetchedAt : Infinity;
  const ttl = cached && cached.trails.length === 0 ? TRAILS_EMPTY_TTL_MS : TRAILS_TTL_MS;
  if (cached && age < ttl) {
    return { trails: withDistances(cached.trails, loc), fetchedAt: cached.fetchedAt, origin: 'cache' };
  }

  const livePromise = deps.live();
  livePromise
    .then((trails) => deps.write({ fetchedAt: deps.now(), trails }))
    .catch(() => undefined); // the race below reports failure; this only fills the cache
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TrailsBusyError()), deps.deadlineMs);
  });

  try {
    const trails = await Promise.race([livePromise, deadline]);
    return { trails, fetchedAt: deps.now(), origin: 'live' };
  } catch (err) {
    if (cached && age < TRAILS_STALE_MAX_MS) {
      return { trails: withDistances(cached.trails, loc), fetchedAt: cached.fetchedAt, origin: 'stale' };
    }
    throw isBusyError(err) ? new TrailsBusyError() : err;
  } finally {
    clearTimeout(timer);
  }
}

export function loadTrails(loc: SavedLocation, radiusKm = 15): Promise<TrailsResult> {
  const key = trailsCacheKey(loc, radiusKm);
  return resolveTrails(
    {
      read: () => dbGet<CacheEntry>(STORE_LATEST, key),
      write: (e) => dbPut(STORE_LATEST, e, key),
      live: () => fetchTrails(loc, radiusKm),
      now: () => Date.now(),
      deadlineMs: TRAILS_DEADLINE_MS,
    },
    loc,
  );
}
