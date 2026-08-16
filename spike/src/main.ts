/**
 * Gate G0.4 — particle-engine spike harness.
 *
 * Two canvases, stacked:
 *   #basemap    MapLibre GL JS 5.24.0. Repaints ONLY when the camera moves.
 *   #particles  our own WebGL2 canvas, animating every frame independently.
 *
 * That separation is the whole architectural claim being tested. MapLibre repaints are
 * CPU/GPU-heavy under continuous animation, so driving particles through a custom layer
 * forces a full map repaint per frame. The community fix is a second canvas — and the HUD
 * measures whether it is actually working rather than taking it on faith.
 *
 * Throwaway by design. Measure, decide, record the decision in an ADR, delete.
 */

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { BaselineEngine } from './engines/baseline';
import { Hud } from './hud';
import type { EngineParams, ParticleEngine, ViewState, WindField } from './engines/types';

const PARAMS: EngineParams = {
  particleCount: 1_000_000,
  speedFactor: 1.0,
  fadeOpacity: 0.96,
  dropRate: 0.003,
};

// Candidate registry. Add a wrapper per library evaluated; the HUD reports each one's
// integration cost in its own words via `provenance`.
const ENGINES: Array<() => ParticleEngine> = [
  () => new BaselineEngine(),
  // () => new MapLibreGlWindEngine(),   // npm: maplibre-gl-wind (MIT, updated 2026-08-15)
  // () => new WeatherLayersEngine(),    // npm: weatherlayers-gl (MPL-2.0 OR custom terms)
];

async function loadWindField(): Promise<WindField> {
  const [meta, image] = await Promise.all([
    fetch('/wind.json').then((r) => {
      if (!r.ok) throw new Error('wind.json missing — run: pnpm fixture');
      return r.json();
    }),
    new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('wind.png missing — run: pnpm fixture'));
      img.src = '/wind.png';
    }),
  ]);

  return {
    image,
    width: meta.width,
    height: meta.height,
    uMin: meta.uMin,
    uMax: meta.uMax,
    vMin: meta.vMin,
    vMax: meta.vMax,
    cycle: meta.cycle,
    source: meta.source,
  };
}

function readView(map: maplibregl.Map, canvas: HTMLCanvasElement): ViewState {
  const c = map.getCenter();
  const zoom = map.getZoom();
  const lat = Math.max(-85.051129, Math.min(85.051129, c.lat));

  return {
    centerX: (c.lng + 180) / 360,
    centerY:
      0.5 -
      Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI),
    worldSize: 512 * Math.pow(2, zoom),
    bearing: map.getBearing(),
    width: canvas.width,
    height: canvas.height,
    dpr: window.devicePixelRatio || 1,
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('particles') as HTMLCanvasElement;
  const hudEl = document.getElementById('hud')!;

  const gl = canvas.getContext('webgl2', {
    antialias: false,
    depth: false,
    stencil: false,
    alpha: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
  });
  if (!gl) {
    hudEl.innerHTML = '<div class="fail">WebGL2 unavailable — this machine cannot run the spike.</div>';
    return;
  }

  const map = new maplibregl.Map({
    container: 'basemap',
    style: 'https://tiles.openfreemap.org/styles/positron',
    center: [-30, 30],
    zoom: 2,
    // Pitch is disabled deliberately: the overlay projects with a flat Web Mercator transform,
    // and adding a tilted projection to the spike would test the harness, not the engines.
    pitch: 0,
    pitchWithRotate: false,
    attributionControl: { compact: true },
  });

  const hud = new Hud(hudEl, gl);
  map.on('render', () => hud.noteMapRender());

  const field = await loadWindField();
  hud.setStats({
    fixture: `${field.cycle} · ${field.width}×${field.height} · GFS`,
    requestedParticles: PARAMS.particleCount,
  });

  let engineIndex = 0;
  let engine = ENGINES[engineIndex]!();
  engine.init(gl, field, PARAMS);
  hud.setStats({
    engineLabel: engine.label,
    provenance: engine.provenance,
    actualParticles: engine.actualParticleCount(),
  });

  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      engine.resize(w, h);
    }
  }
  resize();
  window.addEventListener('resize', resize);

  // ---- controls
  const bind = (id: string, key: keyof EngineParams, fmt: (v: number) => string) => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    const out = document.getElementById(`${id}-val`);
    if (!input) return;
    const apply = () => {
      (PARAMS[key] as number) = Number(input.value);
      if (out) out.textContent = fmt(Number(input.value));
      engine.setParams(PARAMS);
      hud.setStats({
        actualParticles: engine.actualParticleCount(),
        requestedParticles: PARAMS.particleCount,
      });
    };
    input.addEventListener('input', apply);
    apply();
  };

  bind('count', 'particleCount', (v) => v.toLocaleString());
  bind('speed', 'speedFactor', (v) => v.toFixed(2) + '×');
  bind('fade', 'fadeOpacity', (v) => v.toFixed(3));
  bind('drop', 'dropRate', (v) => v.toFixed(4));

  const engineSel = document.getElementById('engine') as HTMLSelectElement | null;
  if (engineSel) {
    ENGINES.forEach((make, i) => {
      const probe = make();
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = probe.label;
      engineSel.appendChild(opt);
      probe.dispose?.();
    });
    engineSel.value = String(engineIndex);
    engineSel.addEventListener('change', () => {
      engine.dispose();
      engineIndex = Number(engineSel.value);
      engine = ENGINES[engineIndex]!();
      engine.init(gl, field, PARAMS);
      engine.resize(canvas.width, canvas.height);
      hud.setStats({
        engineLabel: engine.label,
        provenance: engine.provenance,
        actualParticles: engine.actualParticleCount(),
      });
    });
  }

  // ---- the loop
  function frame(): void {
    resize();
    engine.frame(readView(map, canvas));
    hud.tick();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- headless verification hook
  // requestAnimationFrame is paused whenever the tab is not compositing, which makes the
  // harness unverifiable from an automation context. This lets the pipeline be stepped and
  // inspected directly: window.__spike.step(60); window.__spike.coverage().
  (window as unknown as Record<string, unknown>)['__spike'] = {
    step(n = 1) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) engine.frame(readView(map, canvas));
      gl.finish();
      const ms = performance.now() - t0;
      return { frames: n, totalMs: +ms.toFixed(1), msPerFrame: +(ms / n).toFixed(2),
               impliedFps: +(1000 / (ms / n)).toFixed(1) };
    },
    /** Fraction of canvas pixels with any particle colour — proves the pipeline drew something. */
    coverage() {
      const px = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let lit = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i]! > 0) lit++;
      return { litPixels: lit, totalPixels: canvas.width * canvas.height,
               fraction: +(lit / (canvas.width * canvas.height)).toFixed(5) };
    },
    info: () => ({
      engine: engine.label,
      particles: engine.actualParticleCount(),
      canvas: `${canvas.width}x${canvas.height}`,
      fixture: `${field.cycle} ${field.width}x${field.height}`,
      zoom: +map.getZoom().toFixed(2),
      center: map.getCenter().toArray().map((n) => +n.toFixed(2)),
    }),
    setCount(n: number) {
      PARAMS.particleCount = n;
      engine.setParams(PARAMS);
      return engine.actualParticleCount();
    },
  };
}

main().catch((err) => {
  document.getElementById('hud')!.innerHTML =
    `<div class="fail">${String(err && (err as Error).message ? (err as Error).message : err)}</div>`;
  console.error(err);
});
