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
