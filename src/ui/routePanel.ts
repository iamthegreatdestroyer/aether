/**
 * Route mode — click waypoints, pick a pace, read the weather at your arrival times.
 *
 * The UI half of the trajectory sampler. While route mode is on, map clicks build the
 * polyline instead of adding saved locations (main.ts gates its click handler on
 * `isRouteMode()`), the route bar shows mode/departure/distance, and each computed sample
 * renders as a chip: local arrival time, conditions, wind. The map draws the path and colors
 * each sample point by precipitation probability — the "when you'll be there" picture the
 * plain forecast map cannot give.
 */

import { fmtTemp } from './units';
import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import { ROUTE_MODES, sampleRoute } from '../data/trajectory';
import type { RouteMode, RoutePlan, Waypoint } from '../data/trajectory';
import { registerLayer } from '../layers/registry';

const LINE_ID = 'route-line';
const PTS_ID = 'route-points';

let map: MapLibreMap;
let bar: HTMLElement;
let active = false;
let layersReady = false;
let waypoints: Waypoint[] = [];
let mode: RouteMode = 'car';
let departOffsetH = 0;
let plan: RoutePlan | null = null;

export function isRouteMode(): boolean {
  return active;
}

export function initRoutePanel(m: MapLibreMap, barEl: HTMLElement, toggleBtn: HTMLButtonElement): void {
  map = m;
  bar = barEl;
  toggleBtn.addEventListener('click', () => setActive(!active, toggleBtn));
  render();
}

function setActive(on: boolean, btn: HTMLButtonElement): void {
  active = on;
  btn.classList.toggle('is-on', on);
  bar.hidden = !on;
  if (!on) clear();
  render();
}

export function addWaypoint(lat: number, lon: number): void {
  waypoints.push({ lat, lon });
  drawPath();
  void recompute();
}

function clear(): void {
  waypoints = [];
  plan = null;
  drawPath();
  render();
}

async function recompute(): Promise<void> {
  if (waypoints.length < 2) {
    plan = null;
    render();
    return;
  }
  try {
    plan = await sampleRoute(waypoints, mode, Date.now() + departOffsetH * 3_600_000);
  } catch (err) {
    plan = null;
    bar.querySelector('.route-results')!.textContent =
      err instanceof Error ? err.message : String(err);
    drawPath();
    return;
  }
  drawPath();
  render();
}

function drawPath(): void {
  const line = {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'LineString' as const, coordinates: waypoints.map((w) => [w.lon, w.lat]) },
  };
  const pts = {
    type: 'FeatureCollection' as const,
    features: (plan?.samples ?? []).map((s) => ({
      type: 'Feature' as const,
      properties: { prob: s.precipProb ?? 0 },
      geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
    })),
  };
  if (!layersReady) {
    if (waypoints.length === 0) return;
    registerLayer('route', 'open-meteo');
    map.addSource(LINE_ID, { type: 'geojson', data: line });
    map.addSource(PTS_ID, { type: 'geojson', data: pts });
    map.addLayer({
      id: LINE_ID, type: 'line', source: LINE_ID,
      paint: { 'line-color': '#6aa9ff', 'line-width': 3, 'line-opacity': 0.85 },
    });
    map.addLayer({
      id: PTS_ID, type: 'circle', source: PTS_ID,
      paint: {
        'circle-radius': 6,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#0b1220',
        // Dry → blue-grey; likely rain → amber→red. The route becomes its own legend.
        'circle-color': [
          'interpolate', ['linear'], ['get', 'prob'],
          0, '#5b7fb4', 40, '#d9c54a', 70, '#e0973d', 90, '#d94040',
        ],
      },
    });
    layersReady = true;
  } else {
    (map.getSource(LINE_ID) as GeoJSONSource).setData(line);
    (map.getSource(PTS_ID) as GeoJSONSource).setData(pts);
  }
}

function render(): void {
  if (!bar) return;
  const modeBtns = (Object.keys(ROUTE_MODES) as RouteMode[])
    .map(
      (m2) =>
        `<button class="route-mode ${m2 === mode ? 'is-on' : ''}" data-mode="${m2}">${ROUTE_MODES[m2].label}</button>`,
    )
    .join('');
  const departBtns = [0, 1, 3, 6]
    .map(
      (h) =>
        `<button class="route-depart ${h === departOffsetH ? 'is-on' : ''}" data-h="${h}">${h === 0 ? 'now' : `+${h}h`}</button>`,
    )
    .join('');

  const chips = plan
    ? plan.samples
        .map(
          (s) => `<span class="route-chip" title="km ${s.kmFromStart} · ${s.weatherLabel} · gusts ${s.gustKmh ?? '?'} km/h">
            <b>${s.arrivalLocal}</b> ${s.weatherGlyph} ${s.tempC !== null ? fmtTemp(s.tempC) : '?'}
            · 💧${s.precipProb ?? 0}% · 💨${s.windKmh !== null ? Math.round(s.windKmh) : '?'}</span>`,
        )
        .join('')
    : waypoints.length === 1
      ? 'click the map to add the next waypoint'
      : 'click the map to start a route';

  const summary = plan
    ? `<span class="route-summary">${plan.totalKm} km · ${plan.durationH} h${
        plan.worst
          ? ` · <span class="route-worst">wettest ~km ${plan.worst.kmFromStart} at ${plan.worst.arrivalLocal} (${plan.worst.precipProb}%)</span>`
          : ' · dry run'
      }</span>`
    : '';

  bar.innerHTML = `
    <div class="route-row">${modeBtns}<span class="route-sep"></span>${departBtns}
      <span class="route-sep"></span>${summary}
      <button class="route-clear" title="Clear route">✕ clear</button></div>
    <div class="route-results">${chips}</div>`;

  bar.querySelectorAll<HTMLButtonElement>('.route-mode').forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset['mode'] as RouteMode;
      void recompute();
    }),
  );
  bar.querySelectorAll<HTMLButtonElement>('.route-depart').forEach((b) =>
    b.addEventListener('click', () => {
      departOffsetH = Number(b.dataset['h']);
      void recompute();
    }),
  );
  bar.querySelector('.route-clear')?.addEventListener('click', clear);
}

/** Debug/verification path: build a route programmatically, same code path as clicks. */
export async function debugRoute(
  wps: Waypoint[],
  m2: RouteMode,
  departOffsetHours: number,
): Promise<RoutePlan> {
  waypoints = [...wps];
  mode = m2;
  departOffsetH = departOffsetHours;
  const p = await sampleRoute(waypoints, mode, Date.now() + departOffsetH * 3_600_000);
  plan = p;
  drawPath();
  render();
  return p;
}
