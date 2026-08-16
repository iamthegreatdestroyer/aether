/**
 * Layer registry — the choke point where the denylist and the non-commercial flag actually
 * bite.
 *
 * P0 registers exactly one layer (the basemap), which makes this look like ceremony. It is
 * the opposite: the deny-list and NONCOMMERCIAL_SOURCES gate only work if there is a single
 * door every layer walks through, and the door has to exist *before* P2 starts wiring radar
 * chains, or the first failover added in a hurry will go around it.
 */

import { assertNotDenied } from '../data/denylist';
import { isSourcePermitted } from '../config/flags';
import { source } from '../data/sources.mjs';

export interface RegisteredLayer {
  id: string;
  sourceId: string;
  role: string;
}

const layers = new Map<string, RegisteredLayer>();

export function registerLayer(id: string, sourceId: string): RegisteredLayer {
  // Order matters: the denylist throws with the durable reason; the flag check explains the
  // commercial boundary. Both fire before anything touches the network.
  assertNotDenied(sourceId);
  if (!isSourcePermitted(sourceId)) {
    throw new Error(
      `Source "${sourceId}" is gated by NONCOMMERCIAL_SOURCES and the flag is off.`,
    );
  }
  const s = source(sourceId); // throws on unknown id — a layer must map to the contract
  const layer: RegisteredLayer = { id, sourceId, role: s.role };
  layers.set(id, layer);
  return layer;
}

export function listLayers(): RegisteredLayer[] {
  return [...layers.values()];
}
