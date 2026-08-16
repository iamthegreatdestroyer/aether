/**
 * @aether/mesh-bridge — reserved slot. No implementation yet, by design.
 *
 * See ./README.md for why this package exists before it does anything, and ACTION_PLAN.md §7
 * for the activation trigger (after Aether P3 ships).
 *
 * The only thing declared here is the boundary contract. Anything that imports GPL-3.0 code
 * (meshtastic-sdk) lives behind this interface and never leaks past it.
 */

/** A single environment observation from a mesh node. Mirrors Meshtastic EnvironmentMetrics. */
export interface MeshObservation {
  /** Stable node identifier. Part of the idempotency key. */
  stationId: string;
  /** Observation time, epoch seconds. Part of the idempotency key. */
  timestamp: number;
  temperatureC?: number;
  relativeHumidity?: number;
  barometricPressureHpa?: number;
  /** Present only where a Lark or equivalent station is fitted (phase 3+). */
  windSpeedMs?: number;
  windDirectionDeg?: number;
  rainfallMm?: number;
}

/**
 * Transport abstraction. Deliberately NOT named after Meshtastic: the same SX1262 hardware can
 * be reflashed to MeshCore, whose pull-based sensor role is a better airtime citizen for fixed
 * solar stations. The interface must survive that swap.
 */
export interface MeshTransport {
  readonly id: 'meshtastic' | 'meshcore';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Observations flow UP: nodes as sensors. */
  observations(): AsyncIterable<MeshObservation>;
  /** Bulletins flow DOWN: nodes as offline clients. Target <= 120 bytes, 1-2 packets. */
  broadcastBulletin(payload: Uint8Array): Promise<void>;
}

/**
 * Idempotency key for deduplication. Replays are duplicate-generating by design — the flood
 * router suppresses duplicate packet IDs in-network, and the app must suppress the rest.
 */
export function observationKey(o: MeshObservation): string {
  return `${o.stationId}:${o.timestamp}`;
}

/** Nothing is wired up yet. Activation is gated on FLAGS.MESH_BRIDGE and Aether P3. */
export const MESH_BRIDGE_READY = false;
