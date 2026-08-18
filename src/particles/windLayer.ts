/**
 * The wind layer — glue between the map, the engine, and the texture pipeline.
 *
 * This is the two-canvas pattern as product code: MapLibre repaints its own canvas only on
 * camera moves, while this layer animates a separate canvas above it at full rate. The spike
 * proved the split empirically (basemap repaints idle at 60 fps particle rate); this module
 * carries it, plus the operational concerns a benchmark harness doesn't need — battery,
 * low-end devices, and honesty about data age.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { WindEngine } from './engine';
import type { EngineParams, ViewState, WindField } from './engine';

/** Same-origin artifacts produced by scripts/build_wind_texture.py (Tier B cron on Pages,
 *  committed snapshots in dev). Relative paths on purpose — work at "/" and "/<repo>/".
 *  File ids are the builder contract: "latest" is the surface level (its P1-era name, kept
 *  so old artifacts and clients stay valid); pressure levels are named by their hPa. */
export const WIND_LEVELS = [
  { id: 'latest', label: 'Sfc', title: '10 m wind' },
  { id: '850', label: '850', title: '850 hPa (~1.5 km)' },
  { id: '500', label: '500', title: '500 hPa (~5.5 km)' },
  { id: '250', label: '250', title: '250 hPa — jet stream (~10.5 km)' },
] as const;
export type WindLevelId = (typeof WIND_LEVELS)[number]['id'];

export interface WindMeta {
  cycle: string;
  validTime: string;
  width: number;
  height: number;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  maxSpeedMs: number;
}

/**
 * Quality ladder. Desktop starts where the spike measured 60 fps with 4x headroom; coarse
 * pointers (phones) start two steps down. The adaptive loop only ever steps DOWN — stepping
 * up produces oscillation on thermally-throttling phones.
 */
const QUALITY_LADDER = [1_000_000, 500_000, 250_000, 100_000, 50_000] as const;

const PARAMS: EngineParams = {
  particleCount: 500_000,
  speedFactor: 1.0,
  fadeOpacity: 0.96,
  dropRate: 0.003,
};

/** Below this measured fps, drop one quality step. Checked over 3-second windows. */
const MIN_ACCEPTABLE_FPS = 40;

export class WindLayer {
  private engine: WindEngine | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private field: WindField | null = null;
  private raf = 0;
  private running = false;
  private qualityIndex: number;
  private frameCount = 0;
  private windowStart = 0;
  private lastFps = 0;

  /** Decoded pixel data kept CPU-side for the picker — same texels the shader samples. */
  private pixels: Uint8ClampedArray | null = null;
  meta: WindMeta | null = null;
  private levelId: WindLevelId = 'latest';

  get level(): WindLevelId {
    return this.levelId;
  }

  /**
   * Switch altitude. The engine's field is set at init, so a level change is a teardown:
   * dispose, forget the field, re-init from the new level's texture. Particle trails from
   * the old level would be a lie at the new one — the clear is intentional, not cosmetic.
   */
  async setLevel(id: WindLevelId): Promise<void> {
    if (id === this.levelId) return;
    this.levelId = id;
    const wasRunning = this.running;
    this.stop();
    this.engine?.dispose();
    this.engine = null;
    this.gl = null;
    this.field = null;
    this.pixels = null;
    this.meta = null;
    if (wasRunning) await this.start();
  }

  constructor(
    private map: MapLibreMap,
    private canvas: HTMLCanvasElement,
  ) {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    this.qualityIndex = coarse ? 2 : 1; // 250k on phones, 500k on desktop
    // Trails smear under camera motion; clearing at gesture start reads as intentional.
    map.on('movestart', () => this.engine?.clearTrails());
  }

  async start(): Promise<void> {
    if (this.running) return;

    if (!this.engine) await this.init();
    this.running = true;
    this.windowStart = performance.now();
    this.frameCount = 0;
    const loop = () => {
      if (!this.running) return;
      this.resize();
      this.engine!.frame(this.readView());
      this.adapt();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    // Leave the last frame visible but clear on next start — a frozen trail field looks
    // like data; better to blank the canvas when the layer is off.
    this.gl?.clear(this.gl.COLOR_BUFFER_BIT);
    this.canvas.style.visibility = 'hidden';
  }

  get isRunning(): boolean {
    return this.running;
  }

  get fps(): number {
    return this.lastFps;
  }

  get particleCount(): number {
    return this.engine?.actualParticleCount() ?? 0;
  }

  private async init(): Promise<void> {
    const base = `data/wind/${this.levelId}`;
    const [meta, image] = await Promise.all([
      fetch(`${base}.json`).then((r) => {
        if (!r.ok) throw new Error('wind sidecar missing — run scripts/build_wind_texture.py');
        return r.json() as Promise<WindMeta>;
      }),
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('wind texture missing'));
        img.src = `${base}.png`;
      }),
    ]);
    this.meta = meta;

    // Keep a CPU copy for the picker before the image goes to the GPU.
    const c = document.createElement('canvas');
    c.width = meta.width;
    c.height = meta.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0);
    this.pixels = ctx.getImageData(0, 0, meta.width, meta.height).data;

    const gl = this.canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      stencil: false,
      alpha: true,
      premultipliedAlpha: true,
    });
    if (!gl) throw new Error('WebGL2 unavailable — wind layer cannot run');
    this.gl = gl;

    this.field = {
      image,
      width: meta.width,
      height: meta.height,
      uMin: meta.uMin,
      uMax: meta.uMax,
      vMin: meta.vMin,
      vMax: meta.vMax,
    };

    this.engine = new WindEngine();
    this.engine.init(gl, this.field, {
      ...PARAMS,
      particleCount: QUALITY_LADDER[this.qualityIndex] ?? 250_000,
    });
    this.resize(true);
  }

  private resize(force = false): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (force || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.engine?.resize(w, h);
    }
    this.canvas.style.visibility = 'visible';
  }

  private readView(): ViewState {
    const c = this.map.getCenter();
    const lat = Math.max(-85.051129, Math.min(85.051129, c.lat));
    return {
      centerX: (c.lng + 180) / 360,
      centerY: 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI),
      worldSize: 512 * Math.pow(2, this.map.getZoom()),
      bearing: this.map.getBearing(),
      width: this.canvas.width,
      height: this.canvas.height,
      dpr: window.devicePixelRatio || 1,
    };
  }

  /** Measure over 3 s windows; on sustained low fps, step down the ladder. Never up. */
  private adapt(): void {
    this.frameCount++;
    const elapsed = performance.now() - this.windowStart;
    if (elapsed < 3_000) return;
    this.lastFps = (this.frameCount / elapsed) * 1000;
    this.frameCount = 0;
    this.windowStart = performance.now();

    if (this.lastFps < MIN_ACCEPTABLE_FPS && this.qualityIndex < QUALITY_LADDER.length - 1) {
      this.qualityIndex++;
      const count = QUALITY_LADDER[this.qualityIndex] ?? 50_000;
      this.engine?.setParams({ ...PARAMS, particleCount: count });
      console.info(`[wind] ${this.lastFps.toFixed(0)} fps — stepping down to ${count} particles`);
    }
  }

  /**
   * Drive n frames synchronously and report pixel coverage — the headless proof that the
   * full GPU path (update shader → draw shader → trail composite) actually renders.
   *
   * Exists because rAF is suspended whenever the tab is not compositing, and the spike
   * established that "it initialized without GL errors" is not evidence of drawing. Coverage
   * must be read in the same task as the draw: the context has preserveDrawingBuffer false,
   * so pixels read between frames are already cleared.
   */
  debugStep(n = 30): { frames: number; litFraction: number } | null {
    if (!this.engine || !this.gl) return null;
    this.resize();
    for (let i = 0; i < n; i++) this.engine.frame(this.readView());
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let lit = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i]! > 0) lit++;
    return { frames: n, litFraction: +(lit / (w * h)).toFixed(4) };
  }

  /**
   * The picker: wind at a geographic point, decoded from the SAME texels the shader samples
   * (bilinear, same 255 scaling). The P1 exit test is that this matches Open-Meteo.
   */
  sampleWind(lng: number, lat: number): { u: number; v: number; speedMs: number; dirDeg: number } | null {
    if (!this.pixels || !this.meta) return null;
    const { width, height, uMin, uMax, vMin, vMax } = this.meta;

    const fx = (((lng + 180) % 360) + 360) % 360 / 360 * (width - 1);
    const fy = ((90 - lat) / 180) * (height - 1);
    if (fy < 0 || fy > height - 1) return null;

    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
    const ax = fx - x0, ay = fy - y0;

    const texel = (x: number, y: number, ch: number) => this.pixels![(y * width + x) * 4 + ch]!;
    const lerp2 = (ch: number) => {
      const top = texel(x0, y0, ch) * (1 - ax) + texel(x1, y0, ch) * ax;
      const bot = texel(x0, y1, ch) * (1 - ax) + texel(x1, y1, ch) * ax;
      return (top * (1 - ay) + bot * ay) / 255;
    };

    const u = uMin + lerp2(0) * (uMax - uMin);
    const v = vMin + lerp2(1) * (vMax - vMin);
    const speedMs = Math.hypot(u, v);
    const dirDeg = (270 - (Math.atan2(v, u) * 180) / Math.PI) % 360;
    return { u, v, speedMs, dirDeg: (dirDeg + 360) % 360 };
  }
}
