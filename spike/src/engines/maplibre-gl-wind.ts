/**
 * Candidate 1 — `maplibre-gl-wind` v0.2.1 (MIT, geoql, last modified 2026-08-15).
 *
 * WHAT THE NAME DOES NOT TELL YOU
 * -------------------------------
 * Despite "maplibre" in the name, this is a **deck.gl layer**: `WindParticleLayer extends
 * LineLayer` from `@deck.gl/layers`. It has no MapLibre custom-layer implementation at all.
 * Adopting it means adopting deck.gl + luma.gl as load-bearing dependencies:
 *
 *     @deck.gl/core  @deck.gl/layers  @deck.gl/mapbox
 *     @luma.gl/core  @luma.gl/engine  @luma.gl/shadertools
 *
 * That is six packages (all >=9.0.0 peers) to get one layer, and it took node_modules here
 * from ~40 MB to 153 MB. For a project whose entire thesis is "$0/month, no backend, ship a
 * PWA", that is a real cost and belongs in the G0.4 write-up, not a footnote.
 *
 * ARCHITECTURE, AND WHY THE COMPARISON IS STILL FAIR
 * --------------------------------------------------
 * Integrated via `MapboxOverlay` with `interleaved: false`. In overlaid mode deck.gl creates
 * its OWN canvas stacked above MapLibre's, which is structurally the same two-canvas pattern
 * the baseline uses. Interleaved mode would render into MapLibre's context and force a full
 * map repaint per frame -- precisely the failure the pattern exists to avoid -- so it is not
 * used, and the HUD's basemap-repaint counter will show the difference if that ever changes.
 *
 * THE COST MODEL IS NOT COMPARABLE ON PARTICLE COUNT
 * ---------------------------------------------------
 * The layer computes `numInstances = numParticles * maxAge`. Each particle is a trail of
 * `maxAge` line segments, so 1,000,000 particles at the default maxAge of 50 submits
 * **50,000,000 line instances** per frame. The baseline draws 1,000,000 GL_POINTS. Judging
 * these side by side on "particles" alone would be meaningless; `primitivesPerFrame()`
 * reports the real number and the HUD shows it.
 *
 * In exchange the trails are true geometry rather than a faded framebuffer, which is a
 * genuinely nicer look and survives camera movement without smearing. Whether that is worth
 * 50x the primitives is exactly what the spike is for.
 */

import type { Layer } from '@deck.gl/core';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { WindParticleLayer } from 'maplibre-gl-wind';
import type { IControl, Map as MapLibreMap } from 'maplibre-gl';

import type {
  EngineContext,
  EngineParams,
  ParticleEngine,
  ViewState,
  WindField,
} from './types';

/** The layer's own documented ceiling (defaultProps: numParticles max 1,000,000). */
const MAX_PARTICLES = 1_000_000;

/** Trail length in segments. Also the multiplier on submitted geometry — see header. */
const MAX_AGE = 50;

export class MapLibreGlWindEngine implements ParticleEngine {
  readonly id = 'maplibre-gl-wind';
  readonly label = 'maplibre-gl-wind 0.2.1 (deck.gl)';
  readonly provenance =
    'npm, MIT, modified 2026-08-15. Actually a deck.gl LineLayer — pulls in 6 deck/luma ' +
    'peers (~113 MB). Overlaid MapboxOverlay, so still a second canvas.';
  readonly ownsSurface = true;

  private map!: MapLibreMap;
  private overlay: MapboxOverlay | null = null;
  private field!: WindField;
  private params!: EngineParams;
  private frameCb: (() => void) | null = null;
  private count = 0;

  init(ctx: EngineContext, field: WindField, params: EngineParams): void {
    this.map = ctx.map as MapLibreMap;
    this.field = field;
    this.params = { ...params };

    this.overlay = new MapboxOverlay({
      // Overlaid, NOT interleaved. See header.
      interleaved: false,
      layers: [this.buildLayer()],
      // deck runs its own animation loop; this is the only honest place to measure its rate.
      onAfterRender: () => this.frameCb?.(),
    });
    this.map.addControl(this.overlay as unknown as IControl);
  }

  /**
   * Returns the deck.gl base `Layer` rather than `WindParticleLayer`.
   *
   * Not cosmetic: the class is declared `WindParticleLayer<D, ExtraPropsT = ...>`, so `new`
   * with an object literal infers ExtraPropsT as that literal's exact shape, which is then
   * not assignable back to the default parameterisation (`image` narrows to `string` where
   * the class declares `string | Texture | null`). Widening to `Layer` — which is all
   * MapboxOverlay needs — sidesteps a variance fight that has nothing to do with the spike.
   * Worth noting as a small integration tax on the library's typings.
   */
  private buildLayer(): Layer {
    const requested = Math.min(this.params.particleCount, MAX_PARTICLES);
    this.count = requested;

    return new WindParticleLayer({
      id: 'aether-spike-wind',
      // The fixture is served as a plain URL; deck loads and uploads it itself.
      image: '/wind.png',
      // Single [min,max] for BOTH channels. build_fixture.py emits a shared symmetric range
      // precisely so this and the baseline's per-channel decode agree on the same field.
      imageUnscale: [this.field.uMin, this.field.uMax],
      bounds: [-180, -90, 180, 90],
      numParticles: requested,
      maxAge: MAX_AGE,
      // The layer's speedFactor is on a 0..1000 scale with a default of 50; the harness
      // slider is a 0..4 multiplier. Map one onto the other so the two engines advect at a
      // visually comparable rate and the slider means the same thing in both.
      speedFactor: 50 * this.params.speedFactor,
      width: 1.5,
      animate: true,
      wrapLongitude: true,
      speedRange: [0, 30],
    });
  }

  setParams(params: EngineParams): void {
    this.params = { ...params };
    // deck.gl is declarative: hand it a new layer and it diffs. There is no imperative
    // setter, which is pleasant here and would be a constraint in a real app.
    this.overlay?.setProps({ layers: [this.buildLayer()] });
  }

  resize(): void {
    // deck.gl sizes itself from the map container. Nothing to do — which is one genuine
    // advantage over the baseline, where resize is manual FBO reallocation.
  }

  frame(_view: ViewState): void {
    // Intentionally empty. `animate: true` makes the layer call requestStep() from its own
    // draw(), so deck drives the loop. The harness must not double-drive it.
  }

  setFrameCallback(cb: () => void): void {
    this.frameCb = cb;
  }

  actualParticleCount(): number {
    return this.count;
  }

  primitivesPerFrame(): { count: number; kind: string } {
    return { count: this.count * MAX_AGE, kind: `line instances (${MAX_AGE}x trail)` };
  }

  dispose(): void {
    if (this.overlay) {
      this.map.removeControl(this.overlay as unknown as IControl);
      this.overlay.finalize();
      this.overlay = null;
    }
    this.frameCb = null;
  }
}
