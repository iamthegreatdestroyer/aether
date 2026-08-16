/**
 * The contract every candidate particle engine must satisfy to be measured.
 *
 * Keeping this deliberately small is the point: if a library cannot be wrapped in these five
 * methods, that is itself a finding about integration cost, and it belongs in the spike
 * report rather than being papered over.
 */

/** Camera state, sampled from MapLibre once per frame. */
export interface ViewState {
  /** Web Mercator world coords of the map centre, both in [0, 1]. */
  centerX: number;
  centerY: number;
  /** Full world size in CSS pixels at the current zoom: 512 * 2^zoom. */
  worldSize: number;
  /** Map bearing in degrees, clockwise. */
  bearing: number;
  /** Canvas size in device pixels. */
  width: number;
  height: number;
  /** devicePixelRatio actually in use. */
  dpr: number;
}

/** The decoded wind fixture: an RGBA texture plus the scaling needed to invert it. */
export interface WindField {
  image: HTMLImageElement;
  width: number;
  height: number;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  /** Provenance, shown in the HUD so a screenshot is self-documenting. */
  cycle: string;
  source: string;
}

export interface EngineParams {
  /** Requested particle count. Engines should honour it or report what they actually used. */
  particleCount: number;
  /** Particle advection speed multiplier. */
  speedFactor: number;
  /** Per-frame trail persistence, 0..1. Higher = longer tails. */
  fadeOpacity: number;
  /** Probability per frame that a particle respawns at random. Prevents clustering. */
  dropRate: number;
}

export interface ParticleEngine {
  readonly id: string;
  readonly label: string;
  /** How this engine was obtained — the integration-cost half of the evaluation. */
  readonly provenance: string;

  init(gl: WebGL2RenderingContext, field: WindField, params: EngineParams): void;
  setParams(params: EngineParams): void;
  resize(width: number, height: number): void;
  /** Advance and draw one frame. */
  frame(view: ViewState): void;
  dispose(): void;

  /** Particles actually being simulated — may differ from the request (texture sizing). */
  actualParticleCount(): number;
}
