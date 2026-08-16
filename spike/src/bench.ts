/**
 * Automated benchmark sweep — G0.6.
 *
 * The browser numbers were read off the HUD by hand. That does not work inside a native Tauri
 * window: there is no console to script and no DOM to query from outside. So the sweep runs
 * itself and pushes results out through a Tauri command to stdout, where `tauri dev` captures
 * them.
 *
 * Deliberately reads the SAME HUD text the browser measurements came from, rather than
 * computing its own fps. Two different measurement paths would make the browser-vs-webview
 * comparison meaningless — the entire question is whether the same number changes.
 */

export interface BenchRow {
  engine: string;
  particles: number;
  primitives: number;
  fps: number;
  p95: number;
  mPrimPerSec: number;
  /** True when the HUD never rendered — no frames ran, so fps/p95 mean nothing. */
  stalled: boolean;
  /**
   * Canvas pixels. Stamped on EVERY row, not once per run, because the first pass of this
   * gate compared a 1920x1009 Tauri window against a 987x910 browser canvas and the 2.16x
   * pixel difference looked exactly like "WebView2 is half the speed of Chrome". These
   * renderers are fill-rate bound; a frame rate without its canvas size is not a measurement.
   */
  canvas: string;
  megapixels: number;
  /** What the sweep asked for, so drift is visible in the raw record. */
  wanted: number;
  /** False if the row must not be used: stalled, count drifted, or canvas changed. */
  trusted: boolean;
  /** Why it is untrusted, empty when it is fine. */
  why: string;
}

/** Deck layers draw 50 line instances per particle; the baseline draws 1 point. */
const PRIMITIVE_TARGETS = [204_800, 819_200, 3_276_800];
const PER_PARTICLE: Record<string, number> = {
  baseline: 1,
  'maplibre-gl-wind': 50,
  'weatherlayers-gl': 50,
};

const SETTLE_MS = 5000;

/**
 * Read the HUD, or say plainly that there is nothing to read.
 *
 * The HUD only re-renders from `hud.tick()`, which only runs from the rAF loop — and rAF is
 * suspended whenever the window is not compositing. A first version of this returned NaN in
 * that case, which serialised to `null` and produced a benchmark table full of nulls that
 * looked like a parsing bug rather than "no frames were rendered". A measurement that cannot
 * be taken must announce itself, not degrade quietly.
 */
function readHud(): { fps: number; p95: number; stalled: boolean } {
  const text = document.getElementById('hud')?.innerText ?? '';
  const fpsMatch = text.match(/([\d.]+)\s*fps/);
  const p95Match = text.match(/p95 frame\s*([\d.]+)/);
  if (!fpsMatch || !p95Match) {
    return { fps: -1, p95: -1, stalled: true };
  }
  return { fps: Number(fpsMatch[1]), p95: Number(p95Match[1]), stalled: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SpikeHook {
  use(id: string): unknown;
  setCount(n: number): number;
  info(): { particles: number; primitives: { count: number } | null };
}

/**
 * Disable the control panel for the duration of an automated sweep.
 *
 * The app opens a real window on a real desktop. The first clean-looking run of G0.6 was
 * silently corrupted by exactly that: particle counts appeared mid-sweep that the sweep never
 * sets (10,000 · 170,000 · 731,025 — slider-shaped values) and the canvas changed size partway
 * through. An automated measurement running in a window someone can touch has to defend
 * itself, or it reports someone else's experiment as its own.
 */
function lockControls(locked: boolean): void {
  const panel = document.getElementById('controls');
  if (!panel) return;
  panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((el) => {
    el.disabled = locked;
  });
  panel.style.opacity = locked ? '0.45' : '';
  let banner = document.getElementById('bench-banner');
  if (locked && !banner) {
    banner = document.createElement('div');
    banner.id = 'bench-banner';
    banner.textContent = 'AUTOMATED SWEEP RUNNING — do not resize the window or touch controls';
    banner.setAttribute(
      'style',
      'position:absolute;top:0;left:0;right:0;z-index:9;padding:6px 10px;' +
        'background:#fbbf24;color:#0b1220;font:600 12px ui-monospace,monospace;text-align:center',
    );
    document.body.appendChild(banner);
  } else if (!locked && banner) {
    banner.remove();
  }
}

export async function runSweep(
  spike: SpikeHook,
  engines: string[],
  onRow?: (row: BenchRow) => void,
): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  lockControls(true);
  let referenceCanvas: string | null = null;

  for (const engine of engines) {
    const per = PER_PARTICLE[engine] ?? 1;
    // Drop the count BEFORE switching. Initialising a deck layer at the top of the range
    // would submit 100M+ line instances on the first frame and hang the renderer.
    spike.setCount(Math.round(PRIMITIVE_TARGETS[0]! / per));
    spike.use(engine);
    await sleep(SETTLE_MS);

    for (const prim of PRIMITIVE_TARGETS) {
      const wanted = Math.round(prim / per);
      spike.setCount(wanted);
      await sleep(SETTLE_MS);
      // Re-assert immediately before reading. If anything moved the count during the settle,
      // this puts it back and gives it a moment rather than recording a number for a
      // configuration the sweep never asked for.
      const settled = spike.info().particles;
      const expected = per === 1 ? wanted : wanted; // deck engines honour the request exactly
      if (per !== 1 && settled !== expected) {
        spike.setCount(wanted);
        await sleep(SETTLE_MS);
      }
      const info = spike.info();
      const { fps, p95, stalled } = readHud();
      const primitives = info.primitives?.count ?? info.particles;
      const cv = document.getElementById('particles') as HTMLCanvasElement | null;
      // The harness canvas is hidden for surface-owning engines, so fall back to deck's.
      const deckCv = document.querySelector<HTMLCanvasElement>('#deckgl-overlay');
      const active = cv && cv.style.display !== 'none' ? cv : (deckCv ?? cv);
      const w = active?.width ?? 0;
      const h = active?.height ?? 0;

      const canvas = `${w}x${h}`;
      referenceCanvas ??= canvas;

      // A row is only trustworthy if the sweep got the configuration it asked for. Both of
      // these have already been violated once by live interaction with the window.
      const countOk = Math.abs(info.particles - wanted) <= Math.max(1, wanted * 0.01);
      const canvasOk = canvas === referenceCanvas;

      const row: BenchRow = {
        engine,
        particles: info.particles,
        primitives,
        fps,
        p95,
        mPrimPerSec: stalled ? -1 : +((primitives * fps) / 1e6).toFixed(1),
        stalled,
        canvas,
        megapixels: +((w * h) / 1e6).toFixed(3),
        wanted,
        trusted: !stalled && countOk && canvasOk,
        why: countOk
          ? canvasOk
            ? ''
            : `canvas changed mid-sweep (${referenceCanvas} -> ${canvas})`
          : `particle count drifted (asked ${wanted}, got ${info.particles})`,
      };
      rows.push(row);
      onRow?.(row);
    }
  }
  lockControls(false);
  return rows;
}
