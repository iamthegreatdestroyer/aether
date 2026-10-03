/**
 * Live aircraft — the Flightradar24 arbitrage.
 *
 * FR24 sells subscriptions for history, alerts and an ad-free map. The positions themselves
 * come from volunteers' radio receivers, and the community aggregators that those same
 * feeders supply publish the data openly under ODbL. Measured 2026-08-18: adsb.lol answers
 * keyless with 174 aircraft around this desk in a single call.
 *
 * WHY THIS IS DESKTOP-ONLY, stated plainly because the UI has to say it too: every open
 * ADS-B lane probed refuses the browser.
 *   adsb.lol        no Access-Control-Allow-Origin at all
 *   airplanes.live  403 to an unfamiliar client
 *   adsb.fi         no CORS header
 *   OpenSky         CORS present but scoped to `https://opensky-network.org` — their own
 *                   page only, which is a deliberate "not for your site" answer
 * A Tier B cron is NOT an option here: aircraft move continuously, and a six-hourly bake of
 * plane positions would be theater — the same judgement that kept lightning live-or-nothing.
 * So this rides the Rust-side transport, the third cheque the desktop shell cashes.
 *
 * ODbL obliges attribution and marking the data's licence; the contract carries both and
 * ATTRIBUTION.md is generated from it.
 */

import { fetchJson, hasNativeTransport } from './fetcher';
import { source } from './sources.mjs';
import { bearingDeg, haversineKm } from './geo';

export interface Aircraft {
  /** ICAO 24-bit address — the only truly stable identity here. */
  hex: string;
  /** Callsign as broadcast, trimmed; may be blank on GA aircraft. */
  flight: string | null;
  /** Registration (tail number) when the aggregator knows it. */
  reg: string | null;
  /** ICAO type code, e.g. B38M. */
  type: string | null;
  lat: number;
  lon: number;
  /** Barometric altitude in feet, or 'ground'. */
  altFt: number | 'ground' | null;
  /** Ground speed, knots. */
  gs: number | null;
  /** True track, degrees. */
  track: number | null;
  /** Vertical rate, ft/min. */
  vertFpm: number | null;
  squawk: string | null;
  emergency: boolean;
  /** Seconds since this aircraft was last seen by the network. */
  seen: number | null;
}

interface RawAc {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground';
  gs?: number;
  track?: number;
  baro_rate?: number;
  geom_rate?: number;
  squawk?: string;
  emergency?: string;
  seen?: number;
}

/** 7500 hijack, 7600 radio failure, 7700 general emergency — worth surfacing, never hiding. */
const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);

export function isFlightAvailable(): boolean {
  return hasNativeTransport();
}

/**
 * Aircraft within `radiusNm` of a point. Radius is capped at the aggregator's own limit;
 * asking for the whole sky in one call is both refused and rude.
 */
export async function fetchAircraft(
  lat: number,
  lon: number,
  radiusNm: number,
): Promise<Aircraft[]> {
  if (!hasNativeTransport()) return [];
  const r = Math.max(1, Math.min(250, Math.round(radiusNm)));
  const base = source('adsb-lol').baseUrl!;
  const d = await fetchJson<{ ac?: RawAc[] }>(
    'adsb-lol',
    `${base}/point/${lat.toFixed(3)}/${lon.toFixed(3)}/${r}`,
  );
  return (d.ac ?? [])
    .filter((a): a is RawAc & { lat: number; lon: number } =>
      typeof a.lat === 'number' && typeof a.lon === 'number',
    )
    .map((a) => ({
      hex: a.hex ?? '',
      flight: a.flight?.trim() || null,
      reg: a.r ?? null,
      type: a.t ?? null,
      lat: a.lat,
      lon: a.lon,
      altFt: a.alt_baro ?? null,
      gs: typeof a.gs === 'number' ? Math.round(a.gs) : null,
      track: typeof a.track === 'number' ? a.track : null,
      vertFpm:
        typeof a.baro_rate === 'number'
          ? Math.round(a.baro_rate)
          : typeof a.geom_rate === 'number'
            ? Math.round(a.geom_rate)
            : null,
      squawk: a.squawk ?? null,
      emergency: (a.emergency != null && a.emergency !== 'none') || EMERGENCY_SQUAWKS.has(a.squawk ?? ''),
      seen: typeof a.seen === 'number' ? Math.round(a.seen) : null,
    }));
}

export interface FlightRoute {
  airlineName: string | null;
  originIata: string | null;
  originName: string | null;
  originLat: number | null;
  originLon: number | null;
  destIata: string | null;
  destName: string | null;
  destLat: number | null;
  destLon: number | null;
}

const routeCache = new Map<string, FlightRoute | null>();

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Does the aircraft's actual position agree with the route adsbdb names for its callsign?
 *
 * adsbdb maps a flight NUMBER to its scheduled leg. That is right until it is not: a diversion,
 * a re-used number, a ferry or repositioning flight all keep the callsign and change the leg.
 * Measured 2026-10-03: DAL482 is listed JFK -> ATL while the aircraft was over Tampa Bay at
 * 23,000 ft heading west-southwest — 1,100 km off that track. The popup stated the route as fact.
 *
 * 'unknown' = not enough to judge (no coordinates, on the ground, or still near an end);
 * the caller shows the route normally then. 'mismatch' = say it is the SCHEDULED route.
 *   - detour: an aircraft on its route has d(origin,a) + d(a,dest) close to d(origin,dest).
 *     Allow 15 % or 150 km (whichever is larger) for weather, holds and vectoring.
 *   - heading: well away from the destination yet flying clearly away from it.
 */
export type RouteFit = 'ok' | 'mismatch' | 'unknown';

export function routeFit(
  r: FlightRoute,
  ac: { lat: number; lon: number; track: number | null; gs: number | null; onGround: boolean },
): RouteFit {
  if (r.originLat === null || r.originLon === null || r.destLat === null || r.destLon === null) return 'unknown';
  if (ac.onGround) return 'unknown';
  const direct = haversineKm(r.originLat, r.originLon, r.destLat, r.destLon);
  const viaAc =
    haversineKm(r.originLat, r.originLon, ac.lat, ac.lon) + haversineKm(ac.lat, ac.lon, r.destLat, r.destLon);
  const detourKm = viaAc - direct;
  if (detourKm > Math.max(150, 0.15 * direct)) return 'mismatch';

  const toDest = haversineKm(ac.lat, ac.lon, r.destLat, r.destLon);
  if (ac.track !== null && ac.gs !== null && ac.gs >= 150 && toDest > 200) {
    const want = bearingDeg(ac.lat, ac.lon, r.destLat, r.destLon);
    const off = Math.abs(((ac.track - want + 540) % 360) - 180);
    if (off > 110) return 'mismatch';
  }
  return 'ok';
}

/**
 * Where a callsign is going, from adsbdb's route database. Cached forever in-session: a
 * flight number's SCHEDULED route is stable (whether this aircraft is on it is `routeFit`'s job), and this is a courtesy lookup on a
 * volunteer service, fired only when a person actually clicks a specific aircraft.
 */
export async function fetchRoute(callsign: string): Promise<FlightRoute | null> {
  const key = callsign.trim().toUpperCase();
  if (!key) return null;
  if (routeCache.has(key)) return routeCache.get(key) ?? null;
  // No native gate here on purpose: the probe corrected adsbdb to Tier A, so routes are
  // browser-reachable even though the POSITIONS that lead you to a callsign are not.

  try {
    const d = await fetchJson<{
      response?: {
        flightroute?: {
          airline?: { name?: string };
          origin?: { iata_code?: string; name?: string; municipality?: string; latitude?: number; longitude?: number };
          destination?: { iata_code?: string; name?: string; municipality?: string; latitude?: number; longitude?: number };
        };
      };
    }>('adsbdb', `${source('adsbdb').baseUrl}/callsign/${encodeURIComponent(key)}`);
    const fr = d.response?.flightroute;
    if (!fr) {
      routeCache.set(key, null);
      return null;
    }
    const route: FlightRoute = {
      airlineName: fr.airline?.name ?? null,
      originIata: fr.origin?.iata_code ?? null,
      originName: fr.origin?.municipality ?? fr.origin?.name ?? null,
      originLat: finite(fr.origin?.latitude),
      originLon: finite(fr.origin?.longitude),
      destIata: fr.destination?.iata_code ?? null,
      destName: fr.destination?.municipality ?? fr.destination?.name ?? null,
      destLat: finite(fr.destination?.latitude),
      destLon: finite(fr.destination?.longitude),
    };
    routeCache.set(key, route);
    return route;
  } catch {
    // A callsign the database has never seen is a normal answer; don't retry it all session.
    routeCache.set(key, null);
    return null;
  }
}

export interface AirframePhoto {
  thumbUrl: string;
  pageUrl: string;
  photographer: string;
}

const photoCache = new Map<string, AirframePhoto | null>();

/**
 * A photo of the specific airframe overhead, by registration. Planespotters' licence is
 * credit: the photographer's name and a link back are REQUIRED, so both travel with the
 * photo rather than being dropped for tidiness. Cached per registration for the session and
 * fetched only when someone clicks a specific aircraft — never for a whole screen of them.
 */
export async function fetchAirframePhoto(reg: string): Promise<AirframePhoto | null> {
  const key = reg.trim().toUpperCase();
  if (!key) return null;
  if (photoCache.has(key)) return photoCache.get(key) ?? null;
  try {
    const d = await fetchJson<{
      photos?: Array<{
        thumbnail_large?: { src?: string };
        thumbnail?: { src?: string };
        link?: string;
        photographer?: string;
      }>;
    }>('planespotters', `${source('planespotters').baseUrl}/${encodeURIComponent(key)}`);
    const p = d.photos?.[0];
    const src = p?.thumbnail_large?.src ?? p?.thumbnail?.src;
    if (!p || !src) {
      photoCache.set(key, null);
      return null;
    }
    const photo: AirframePhoto = {
      thumbUrl: src,
      pageUrl: p.link ?? '',
      photographer: p.photographer ?? 'unknown',
    };
    photoCache.set(key, photo);
    return photo;
  } catch {
    photoCache.set(key, null); // an unphotographed airframe is normal; never retry in a loop
    return null;
  }
}

/** Feet to a human string, with 'on ground' kept as words rather than a fake zero. */
export function altLabel(alt: number | 'ground' | null): string {
  if (alt === 'ground') return 'on ground';
  if (alt === null) return 'altitude unknown';
  return `${alt.toLocaleString()} ft`;
}
