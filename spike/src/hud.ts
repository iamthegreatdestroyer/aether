/**
 * The measurement half of the spike. Without this the harness is a demo, and a demo cannot
 * settle gate G0.4 — the exit test is a number on real hardware, not "looks smooth".
 *
 * What it reports and why each one earns its place:
 *   fps / p95 frame time  — p95 matters more than the mean. A 60 fps average with a 40 ms
 *                           p95 stutters visibly; the mean hides exactly the thing you care
 *                           about on a mid-range phone.
 *   basemap repaints/s    — the two-canvas proof. Hold the camera still: this must fall to
 *                           zero while particle FPS stays at 60. If it tracks the particle
 *                           rate, the split is not working and you are repainting the whole
 *                           map every frame, which is the failure the pattern exists to avoid.
 *   actual particles      — engines round to a texture size; report what ran, not what was asked.
 *   GPU string            — an integrated-GPU result and a discrete-GPU result are different
 *                           findings. A screenshot without this is not evidence.
 */

export interface HudStats {
  engineLabel: string;
  provenance: string;
  actualParticles: number;
  requestedParticles: number;
  fixture: string;
  /**
   * GPU primitives per frame when they differ from the particle count. maplibre-gl-wind draws
   * numParticles x maxAge line instances, so comparing engines on particle count alone would
   * understate it by 50x.
   */
  primitives: { count: number; kind: string } | null;
  /** deck.gl-style engines run their own loop; the two-canvas proof reads differently. */
  ownsSurface: boolean;
}

export class Hud {
  private el: HTMLElement;
  private frameTimes: number[] = [];
  private last = performance.now();
  private mapRenders = 0;
  private particleFrames = 0;
  private windowStart = performance.now();
  private fps = 0;
  private p95 = 0;
  private mapFps = 0;
  private gpu = 'unknown';
  private stats: HudStats = {
    engineLabel: '—', provenance: '', actualParticles: 0,
    requestedParticles: 0, fixture: '—', primitives: null, ownsSurface: false,
  };

  constructor(el: HTMLElement, gl: WebGL2RenderingContext) {
    this.el = el;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      this.gpu = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
    } else {
      this.gpu = String(gl.getParameter(gl.RENDERER));
    }
  }

  setStats(s: Partial<HudStats>): void {
    this.stats = { ...this.stats, ...s };
  }

  /** Clear the rolling windows. Call on engine switch so one engine's numbers never bleed
   *  into the next engine's first reading — that would quietly favour whichever ran second. */
  reset(): void {
    this.frameTimes = [];
    this.particleFrames = 0;
    this.mapRenders = 0;
    this.fps = 0;
    this.p95 = 0;
    this.mapFps = 0;
    this.last = performance.now();
    this.windowStart = performance.now();
  }

  /** Call from MapLibre's `render` event. */
  noteMapRender(): void {
    this.mapRenders++;
  }

  /** Call once per particle frame. */
  tick(): void {
    const now = performance.now();
    this.frameTimes.push(now - this.last);
    this.last = now;
    this.particleFrames++;

    if (now - this.windowStart >= 500) {
      const elapsed = (now - this.windowStart) / 1000;
      this.fps = this.particleFrames / elapsed;
      this.mapFps = this.mapRenders / elapsed;

      const sorted = [...this.frameTimes].sort((a, b) => a - b);
      this.p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;

      this.frameTimes = [];
      this.particleFrames = 0;
      this.mapRenders = 0;
      this.windowStart = now;
      this.render();
    }
  }

  private verdict(): { text: string; cls: string } {
    if (this.fps >= 58 && this.p95 <= 20) return { text: 'PASS — 60 fps', cls: 'pass' };
    if (this.fps >= 55) return { text: 'MARGINAL — check p95', cls: 'warn' };
    if (this.fps >= 28) return { text: 'PARTIAL — 30 fps class', cls: 'warn' };
    return { text: 'FAIL', cls: 'fail' };
  }

  private render(): void {
    const v = this.verdict();
    const split =
      this.mapFps < 1
        ? '<span class="pass">idle — split working</span>'
        : this.mapFps > this.fps * 0.5
          ? '<span class="fail">tracking particle rate — split NOT working</span>'
          : `<span class="warn">${this.mapFps.toFixed(1)}/s</span>`;

    const prim = this.stats.primitives;
    const primRow =
      prim && prim.count !== this.stats.actualParticles
        ? `<div class="row"><label>GPU primitives</label>
             <b class="warn">${prim.count.toLocaleString()}</b>
             <small>${prim.kind}</small></div>`
        : '';

    this.el.innerHTML = `
      <div class="row big"><span>${this.fps.toFixed(1)}</span><small>fps</small>
        <span class="verdict ${v.cls}">${v.text}</span></div>
      <div class="row"><label>p95 frame</label><b>${this.p95.toFixed(1)} ms</b></div>
      <div class="row"><label>particles</label><b>${this.stats.actualParticles.toLocaleString()}</b>
        <small>req ${this.stats.requestedParticles.toLocaleString()}</small></div>
      ${primRow}
      <hr>
      <div class="row"><label>basemap repaints</label>${split}</div>
      <div class="hint">Hold the camera still. Basemap should go idle while fps stays high —
        that is the two-canvas pattern doing its job.</div>
      <hr>
      <div class="row"><label>engine</label><b>${this.stats.engineLabel}</b></div>
      <div class="prov">${this.stats.provenance}</div>
      <div class="row"><label>renders into</label><b>${
        this.stats.ownsSurface ? 'its own canvas (deck.gl overlay)' : 'harness canvas'
      }</b></div>
      <div class="row"><label>GPU</label><b class="gpu">${this.gpu}</b></div>
      <div class="row"><label>fixture</label><b class="gpu">${this.stats.fixture}</b></div>
    `;
  }
}
