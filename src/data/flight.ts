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
  destIata: string | null;
  destName: string | null;
}

const routeCache = new Map<string, FlightRoute | null>();

/**
 * Where a callsign is going, from adsbdb's route database. Cached forever in-session: a
 * flight number's route does not change mid-flight, and this is a courtesy lookup on a
 * volunteer service, fired only when a person actually clicks a specific aircraft.
 */
export async function fetchRoute(callsign: string): Promise<FlightRoute | null> {
  const key = callsign.trim().toUpperCase();
  if (!key) return null;
  if (routeCache.has(key)) return routeCache.get(key) ?? null;
  if (!hasNativeTransport()) return null;

  try {
    const d = await fetchJson<{
      response?: {
        flightroute?: {
          airline?: { name?: string };
          origin?: { iata_code?: string; name?: string; municipality?: string };
          destination?: { iata_code?: string; name?: string; municipality?: string };
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
      destIata: fr.destination?.iata_code ?? null,
      destName: fr.destination?.municipality ?? fr.destination?.name ?? null,
    };
    routeCache.set(key, route);
    return route;
  } catch {
    // A callsign the database has never seen is a normal answer; don't retry it all session.
    routeCache.set(key, null);
    return null;
  }
}

/** Feet to a human string, with 'on ground' kept as words rather than a fake zero. */
export function altLabel(alt: number | 'ground' | null): string {
  if (alt === 'ground') return 'on ground';
  if (alt === null) return 'altitude unknown';
  return `${alt.toLocaleString()} ft`;
}
