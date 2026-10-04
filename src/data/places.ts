/**
 * Place naming — reverse geocoding, finally.
 *
 * P0 deliberately avoided reverse geocoding: Open-Meteo's geocoding sub-product is
 * CC BY-NC, and a non-commercial clause sitting inside an otherwise clean stack is the kind
 * of thing that quietly forecloses a future decision. So locations were named by hand and
 * the Home pin was simply "📍 Home".
 *
 * The owner's OSINT board surfaced the alternative (2026-08-18): **Nominatim** — OpenStreetMap's
 * own geocoder, ODbL, the same licence family as Overpass which this app already uses, and
 * measured CORS-open and keyless. So a location can now name itself.
 *
 * Nominatim's usage policy is strict and taken seriously here: it is a volunteer-funded
 * service that explicitly forbids heavy use. This module fires ONE request when a person
 * adds a location — never on pan, never on load, never in a loop — and the fetch scheduler
 * holds it to the published one-request-per-second floor.
 */

import { fetchJson } from './fetcher';
import { source } from './sources.mjs';

interface NominatimAddress {
  neighbourhood?: string;
  suburb?: string;
  hamlet?: string;
  village?: string;
  town?: string;
  city?: string;
  county?: string;
  state?: string;
  country_code?: string;
}

/**
 * Best short name for a point, or null. The cascade runs specific → general on purpose: at
 * a coastline or in open country the specific tiers are simply absent, and answering
 * "Manatee County" is honest where inventing a neighbourhood would not be.
 */
export async function reverseName(lat: number, lon: number): Promise<string | null> {
  try {
    const u = new URL(source('nominatim').baseUrl!);
    u.searchParams.set('format', 'jsonv2');
    u.searchParams.set('lat', lat.toFixed(5));
    u.searchParams.set('lon', lon.toFixed(5));
    // zoom 15 is the sweet spot measured across three continents: 16 returns street names
    // ("77th East Terrace"), 14 collapses cities into counties.
    u.searchParams.set('zoom', '15');
    u.searchParams.set('addressdetails', '1');
    const d = await fetchJson<{ address?: NominatimAddress; name?: string }>(
      'nominatim',
      u.toString(),
    );
    const a = d.address ?? {};
    return (
      d.name ||
      a.neighbourhood ||
      a.suburb ||
      a.hamlet ||
      a.village ||
      a.town ||
      a.city ||
      a.county ||
      a.state ||
      null
    );
  } catch {
    // Naming is a convenience; a failed lookup must never block adding a location.
    return null;
  }
}

/**
 * The name, but never at the cost of making someone wait. Whatever has arrived by the
 * deadline is what gets offered — the prompt opens either way.
 */
export async function reverseNameSoon(lat: number, lon: number, ms = 1800): Promise<string | null> {
  return Promise.race([
    reverseName(lat, lon),
    new Promise<null>((r) => setTimeout(() => r(null), ms)),
  ]);
}

// ------------------------------------------------------------------ forward search

export interface PlaceHit {
  /** Short name suitable for a saved location ("Sarasota", "1600 Pennsylvania Avenue"). */
  name: string;
  /** Longer line for telling lookalikes apart ("Sarasota County, Florida, United States"). */
  label: string;
  lat: number;
  lon: number;
}

interface NominatimHit {
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
  address?: NominatimAddress & { road?: string; house_number?: string; postcode?: string };
}

export class PlaceSearchError extends Error {}

const US_ZIP = /^\d{5}(-\d{4})?$/;
const BARE_AREA_CODE = /^\(?\d{3}\)?$/;

/**
 * Forward geocoding — a typed address, ZIP, town or landmark to coordinates. Same host, same
 * ODbL licence and same one-request-per-second bucket as reverseName (it deliberately reuses
 * the 'nominatim' scheduler id so the two cannot add up to more than the published policy).
 *
 * Fired ONLY on an explicit Search press — never as-you-type: Nominatim's policy forbids
 * auto-complete. Phone area codes are refused with a reason: they are a numbering plan, not a
 * place, and OSM does not know them, so a guess would be a confident wrong answer.
 */
export async function searchPlaces(query: string): Promise<PlaceHit[]> {
  const q = query.trim().replace(/\s+/g, ' ');
  if (q.length < 3) throw new PlaceSearchError('Type at least 3 characters.');
  if (BARE_AREA_CODE.test(q)) {
    throw new PlaceSearchError(
      'A phone area code is not a place on the map — try a ZIP code, town or street address.',
    );
  }

  const run = async (params: Record<string, string>): Promise<NominatimHit[]> => {
    const u = new URL('search', source('nominatim').baseUrl!);
    u.searchParams.set('format', 'jsonv2');
    u.searchParams.set('addressdetails', '1');
    u.searchParams.set('limit', '6');
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return fetchJson<NominatimHit[]>('nominatim', u.toString());
  };

  // A bare 5-digit number is ambiguous worldwide (34235 is also Durango, Mexico and Istanbul);
  // try it as a US ZIP first, and only widen the question if the US has no such code.
  let raw: NominatimHit[] = [];
  if (US_ZIP.test(q)) raw = await run({ postalcode: q.slice(0, 5), countrycodes: 'us' });
  if (raw.length === 0) raw = await run({ q });

  const seen = new Set<string>();
  const hits: PlaceHit[] = [];
  for (const r of raw) {
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (seen.has(key)) continue; // OSM often returns the same spot as node + way + relation
    seen.add(key);
    const a = r.address ?? {};
    const street = a.road ? `${a.house_number ? a.house_number + ' ' : ''}${a.road}` : null;
    const name =
      r.name || street || a.neighbourhood || a.suburb || a.hamlet || a.village || a.town ||
      a.city || a.county || r.display_name.split(',')[0]!.trim();
    hits.push({ name, label: r.display_name, lat: +lat.toFixed(4), lon: +lon.toFixed(4) });
  }
  return hits;
}
