/**
 * Severe weather alerts — the part of a storm app that actually matters.
 *
 * The RadarScope strike, redirected by what the probes showed (2026-08-18). Their paid tiers
 * sell radar depth: lightning (Aether already has it, live, free), archives, and shear
 * products. The MRMS national mosaic and Level 2 volumes are both openly hosted — but MRMS
 * arrives as GRIB2 template 5.41 (PNG-packed), which our decoder does not yet read, and more
 * decisively: **radar baked on a six-hourly cron would be stale by design**, the same test
 * that kept lightning live-or-nothing. Documented as a future first-source path, not faked.
 *
 * What IS live, keyless and browser-reachable is the thing a person needs first: NWS active
 * alerts. Measured: `Access-Control-Allow-Origin: *`, 261 alerts nationwide, 86 of them
 * carrying warning polygons, and a point query answers "what is in force at this exact spot".
 * A tornado warning over your house outranks a prettier reflectivity ramp.
 */

import { fetchJson } from './fetcher';
import { source } from './sources.mjs';
import type { SavedLocation } from '../ui/locations';

export type Severity = 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';

export interface Alert {
  id: string;
  event: string;
  severity: Severity;
  urgency: string;
  certainty: string;
  headline: string | null;
  description: string | null;
  instruction: string | null;
  senderName: string | null;
  effectiveMs: number | null;
  expiresMs: number | null;
  /** Present on ~a third of alerts: the drawn warning box. */
  geometry: GeoJSON.Geometry | null;
}

interface RawFeature {
  id?: string;
  geometry?: GeoJSON.Geometry | null;
  properties?: {
    event?: string;
    severity?: string;
    urgency?: string;
    certainty?: string;
    headline?: string;
    description?: string;
    instruction?: string;
    senderName?: string;
    effective?: string;
    expires?: string;
  };
}

const ms = (t?: string) => (t ? Date.parse(t) : null);

function toAlert(f: RawFeature): Alert {
  const p = f.properties ?? {};
  return {
    id: f.id ?? `${p.event}-${p.effective}`,
    event: p.event ?? 'Alert',
    severity: (p.severity as Severity) ?? 'Unknown',
    urgency: p.urgency ?? 'Unknown',
    certainty: p.certainty ?? 'Unknown',
    headline: p.headline ?? null,
    description: p.description ?? null,
    instruction: p.instruction ?? null,
    senderName: p.senderName ?? null,
    effectiveMs: ms(p.effective),
    expiresMs: ms(p.expires),
    geometry: f.geometry ?? null,
  };
}

/** Rank so the worst thing in force is what a card shows. */
const SEVERITY_RANK: Record<Severity, number> = {
  Extreme: 4,
  Severe: 3,
  Moderate: 2,
  Minor: 1,
  Unknown: 0,
};

export function worst(alerts: Alert[]): Alert | null {
  if (alerts.length === 0) return null;
  return [...alerts].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0]!;
}

export function severityClass(s: Severity): string {
  return `alert-${s.toLowerCase()}`;
}

/** Everything in force at one point — the query a saved location actually wants. */
export async function fetchAlertsForPoint(loc: SavedLocation): Promise<Alert[]> {
  const u = `${source('nws-alerts').baseUrl}/active?status=actual&point=${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`;
  const d = await fetchJson<{ features?: RawFeature[] }>('nws-alerts', u);
  return (d.features ?? []).map(toAlert);
}

/**
 * Alerts WITH polygons, for the map. Only ~a third of alerts are drawn boxes — the rest are
 * issued for whole counties or marine zones, and inventing a shape for those would be a lie,
 * so the layer simply carries the ones that came with geometry and the panel lists the rest.
 */
export async function fetchAlertPolygons(): Promise<Alert[]> {
  const u = `${source('nws-alerts').baseUrl}/active?status=actual`;
  const d = await fetchJson<{ features?: RawFeature[] }>('nws-alerts', u);
  return (d.features ?? [])
    .map(toAlert)
    .filter((a) => a.geometry !== null && a.severity !== 'Minor' && a.severity !== 'Unknown');
}

/** "until 7:00 PM" / "expired" — alerts are only useful with their clock attached. */
export function expiryLabel(a: Alert): string {
  if (!a.expiresMs) return 'no stated expiry';
  const mins = Math.round((a.expiresMs - Date.now()) / 60_000);
  if (mins < 0) return 'expired';
  const when = new Date(a.expiresMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (mins < 60) return `until ${when} (${mins} min)`;
  if (mins < 24 * 60) return `until ${when}`;
  const day = new Date(a.expiresMs).toLocaleDateString(undefined, { weekday: 'short' });
  return `until ${day} ${when}`;
}
