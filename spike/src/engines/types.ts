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

/**
 * What the harness hands an engine at init.
 *
 * It carries BOTH surfaces because the two engines wired up so far want different ones, and
 * that difference is a finding rather than an inconvenience: the baseline renders into the
 * harness's own canvas, while `maplibre-gl-wind` is a deck.gl layer that brings its own.
 */
export interface EngineContext {
  /** The harness's overlay canvas and its WebGL2 context. Unused by surface-owning engines. */
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  /**
   * The MapLibre map. Typed structurally so this file stays dependency-free — engines that
   * need the real type import it themselves.
   */
  map: unknown;
}

export interface ParticleEngine {
  readonly id: string;
  readonly label: string;
  /** How this engine was obtained — the integration-cost half of the evaluation. */
  readonly provenance: string;

  /**
   * True if the engine creates and drives its own canvas and render loop.
   *
   * This flag exists because `maplibre-gl-wind` could not be wrapped without it, and the
   * comment at the top of this file said that would itself be a finding. It is: deck.gl owns
   * a Deck instance with its own animation loop, so the harness must stop driving frames and
   * instead measure the frames deck reports. Both engines still render to a SEPARATE canvas
   * above the basemap, so the two-canvas comparison stays honest.
   */
  readonly ownsSurface: boolean;

  init(ctx: EngineContext, field: WindField, params: EngineParams): void;
  setParams(params: EngineParams): void;
  resize(width: number, height: number): void;
  /** Advance and draw one frame. No-op for surface-owning engines — they drive themselves. */
  frame(view: ViewState): void;
  /**
   * Surface-owning engines must invoke this once per frame THEY render, so the HUD measures
   * the engine's real frame rate rather than the harness's idle loop.
   */
  setFrameCallback(cb: () => void): void;
  dispose(): void;

  /** Particles actually being simulated — may differ from the request (texture sizing). */
  actualParticleCount(): number;

  /**
   * GPU primitives actually submitted per frame, when that differs materially from the
   * particle count. `maplibre-gl-wind` draws numParticles x maxAge line instances, so at a
   * million particles it is submitting fifty million — comparing it to the baseline's one
   * million points on particle count alone would be badly misleading.
   */
  primitivesPerFrame?(): { count: number; kind: string };
}
