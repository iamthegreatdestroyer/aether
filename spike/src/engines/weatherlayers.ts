/**
 * Candidate 2 — `weatherlayers-gl` v2026.5.2 (Kamzek s.r.o.).
 *
 * LICENSING — READ THIS BEFORE ADOPTING
 * -------------------------------------
 * Dual-licensed: `(MPL-2.0 OR LicenseRef-LICENSE_TERMS_OF_USE.md)`. The two halves are very
 * different, and the commercial half would rule this out entirely:
 *
 *   LICENSE_TERMS_OF_USE.md, Art. 1.2: "The User declares he/she concludes the Contract only
 *   for purposes of its **business activity** and he/she is not in a position of consumer.
 *   **Consumers may not conclude this Contract and may not use the Library** on the basis of
 *   the Terms."
 *
 * Aether is a personal, non-commercial hobby project — squarely a consumer. So the commercial
 * Terms are unavailable to it, and there is a EUR 4,000 contractual penalty attached to data
 * warranty breaches under Art. 4.4.
 *
 * **We therefore take the MPL-2.0 option, which carries no field-of-use restriction.** That is
 * a deliberate, recorded choice, not a default. MPL-2.0 is file-level copyleft: modifying
 * weatherlayers' own source files and then *distributing* obliges publishing those files under
 * MPL. Consuming it unmodified inside a larger work of any licence is fine, and Aether is
 * never conveyed anyway. If Aether ever monetises, revisit — the vendor's pricing page is the
 * point of the dual licence.
 *
 * PRIVACY NOTE
 * ------------
 * Depends on `@scarf/scarf` with `scarfSettings: {allowTopLevel: true}` — install-time
 * analytics that reports package/platform telemetry. For a project whose pitch is "no
 * accounts, no ads, no tracking" that deserves a conscious decision; it is disabled with
 * `SCARF_ANALYTICS=false` or a `scarfSettings.enabled=false` entry in our own package.json.
 *
 * ARCHITECTURE
 * ------------
 * Also a deck.gl layer (`ParticleLayer extends CompositeLayer`), so like `maplibre-gl-wind` it
 * arrives via MapboxOverlay in overlaid mode and owns its own canvas. Peers: @deck.gl/core,
 * @deck.gl/layers, @deck.gl/extensions, @luma.gl/core, @luma.gl/engine, geotiff.
 *
 * INTEGRATION DIFFERENCE WORTH PRICING
 * ------------------------------------
 * `image` is `TextureData` — `{data: TypedArray, width, height}` — NOT a URL. deck.gl's layer
 * loads a URL for you; this one does not, so the harness decodes the PNG to raw RGBA through a
 * canvas first. Slightly more work, but strictly more control: it is the same shape a Tier B
 * pipeline would hand it, so in a real build this is arguably the better interface.
 */

import type { Layer } from '@deck.gl/core';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ImageInterpolation, ImageType, ParticleLayer } from 'weatherlayers-gl';
import type { IControl, Map as MapLibreMap } from 'maplibre-gl';

import type {
  EngineContext,
  EngineParams,
  ParticleEngine,
  ViewState,
  WindField,
} from './types';

/** Trail length in segments — the same multiplier on submitted geometry as the other layer. */
const MAX_AGE = 50;

/** Decode an HTMLImageElement to raw RGBA, which is what `TextureData` wants. */
function toTextureData(img: HTMLImageElement): {
  data: Uint8Array;
  width: number;
  height: number;
} {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: new Uint8Array(data.buffer.slice(0)), width, height };
}

export class WeatherLayersEngine implements ParticleEngine {
  readonly id = 'weatherlayers-gl';
  readonly label = 'weatherlayers-gl 2026.5.2 (deck.gl)';
  readonly provenance =
    'npm, taken under MPL-2.0 — its commercial Terms forbid consumers outright. ' +
    'deck.gl CompositeLayer; pulls @deck.gl/extensions + geotiff on top of deck/luma. ' +
    'Bundles @scarf/scarf install analytics.';
  readonly ownsSurface = true;

  private map!: MapLibreMap;
  private overlay: MapboxOverlay | null = null;
  private field!: WindField;
  private params!: EngineParams;
  private texture!: { data: Uint8Array; width: number; height: number };
  private frameCb: (() => void) | null = null;
  private count = 0;

  init(ctx: EngineContext, field: WindField, params: EngineParams): void {
    this.map = ctx.map as MapLibreMap;
    this.field = field;
    this.params = { ...params };
    this.texture = toTextureData(field.image);

    this.overlay = new MapboxOverlay({
      interleaved: false, // overlaid — deck gets its own canvas, two-canvas pattern preserved
      layers: [this.buildLayer()],
      onAfterRender: () => this.frameCb?.(),
    });
    this.map.addControl(this.overlay as unknown as IControl);
  }

  /** Returns the base `Layer` for the same generic-variance reason as the other deck engine. */
  private buildLayer(): Layer {
    this.count = this.params.particleCount;

    return new ParticleLayer({
      id: 'aether-spike-weatherlayers',
      image: this.texture,
      // VECTOR = the R/G channels are u/v components rather than a scalar field.
      imageType: ImageType.VECTOR,
      // Same single [min,max] convention as maplibre-gl-wind, which is why build_fixture.py
      // emits one shared symmetric range — all three engines then decode the same field.
      imageUnscale: [this.field.uMin, this.field.uMax],
      imageInterpolation: ImageInterpolation.LINEAR,
      bounds: [-180, -90, 180, 90],
      numParticles: this.count,
      maxAge: MAX_AGE,
      // Same 0..1000-scale mapping as the other deck layer so the harness slider means the
      // same thing across all three engines.
      speedFactor: 50 * this.params.speedFactor,
      width: 1.5,
      animate: true,
      color: [255, 255, 255, 255],
    } as never);
  }

  setParams(params: EngineParams): void {
    this.params = { ...params };
    this.overlay?.setProps({ layers: [this.buildLayer()] });
  }

  resize(): void {
    // deck sizes itself from the map container.
  }

  frame(_view: ViewState): void {
    // No-op: `animate: true` means deck drives its own loop.
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
