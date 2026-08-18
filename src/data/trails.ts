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

import { fetchJson } from './fetcher';
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
  const d = await fetchJson<{ elements?: OverpassWay[] }>(
    'overpass',
    `${source('overpass').baseUrl}?data=${encodeURIComponent(q)}`,
  );

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
