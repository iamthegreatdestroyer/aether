/**
 * Aether — P0 entry point.
 *
 * Boot order is the offline story: render every card from the IndexedDB snapshot FIRST, then
 * refresh from the network and re-render. A fresh boot with no connectivity shows the last
 * forecast with an honest "cached" badge instead of a spinner that never resolves — the P6
 * offline exit test, satisfied structurally from day one rather than bolted on.
 */

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './app.css';

import { source } from './data/sources.mjs';
import { fetchForecast } from './data/openmeteo';
import type { ForecastData } from './data/openmeteo';
import { ledgerCount, loadLatest, logForecast, saveLatest } from './data/ledger';
import { registerLayer } from './layers/registry';
import { renderCard } from './ui/forecastCard';
import type { CardState } from './ui/forecastCard';
import { addLocation, loadLocations, locationKey, removeLocation } from './ui/locations';
import type { SavedLocation } from './ui/locations';
import { buildSourcesDialog, renderFooter } from './ui/attribution';
import { WindLayer } from './particles/windLayer';

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

let locations: SavedLocation[] = loadLocations();
const cardStates = new Map<string, CardState>();
const markers = new Map<string, maplibregl.Marker>();

// ---------------------------------------------------------------- map

// The basemap goes through the registry like every future layer will — the denylist and the
// non-commercial flag only work if there are no side doors.
registerLayer('basemap', 'openfreemap');
const basemapStyle = source('openfreemap').baseUrl;
if (!basemapStyle) throw new Error('openfreemap contract entry has no baseUrl');

const map = new maplibregl.Map({
  container: 'map',
  style: basemapStyle,
  center: [-20, 35],
  zoom: 1.7,
  attributionControl: { compact: true },
});

function syncMarkers(): void {
  for (const [id, marker] of markers) {
    if (!locations.some((l) => l.id === id)) {
      marker.remove();
      markers.delete(id);
    }
  }
  for (const loc of locations) {
    if (!markers.has(loc.id)) {
      const marker = new maplibregl.Marker({ color: '#6aa9ff' })
        .setLngLat([loc.lon, loc.lat])
        .setPopup(new maplibregl.Popup({ closeButton: false }).setText(loc.name));
      marker.addTo(map);
      markers.set(loc.id, marker);
    }
  }
}

map.on('click', (e) => {
  const name = window.prompt(
    `Add location at ${e.lngLat.lat.toFixed(2)}, ${e.lngLat.lng.toFixed(2)}?\nName:`,
  );
  if (name === null) return;
  try {
    locations = addLocation(locations, name, e.lngLat.lat, e.lngLat.lng);
  } catch (err) {
    window.alert(String(err instanceof Error ? err.message : err));
    return;
  }
  syncMarkers();
  const added = locations[locations.length - 1];
  if (added) void hydrateLocation(added);
  renderCards();
});

// ---------------------------------------------------------------- cards

const rail = document.getElementById('cards')!;

function handleRemove(id: string): void {
  locations = removeLocation(locations, id);
  cardStates.delete(id);
  syncMarkers();
  renderCards();
}

function renderCards(): void {
  rail.replaceChildren(
    ...locations.map((loc) =>
      renderCard(
        cardStates.get(loc.id) ?? { loc, data: null, fetchedAt: null, stale: false, error: null },
        handleRemove,
      ),
    ),
  );
}

/**
 * Boot trace: every card-state transition, timestamped from page start. Exists because the
 * boot is too fast to observe from outside — snapshot render and the scheduler's request
 * stagger both complete before an injected probe can take its first sample. Verification
 * has to be recorded by the thing being verified.
 */
const bootTrace: Array<{ tMs: number; card: string; to: string }> = [];
(window as unknown as Record<string, unknown>)['__aetherTrace'] = bootTrace;

function setCardState(loc: SavedLocation, patch: Partial<CardState>): void {
  const prev = cardStates.get(loc.id) ?? {
    loc,
    data: null,
    fetchedAt: null,
    stale: false,
    error: null,
  };
  const next = { ...prev, ...patch, loc };
  cardStates.set(loc.id, next);
  bootTrace.push({
    tMs: Math.round(performance.now()),
    card: loc.name,
    to: next.error ? 'error' : !next.data ? 'loading' : next.stale ? 'stale-snapshot' : 'fresh',
  });
  renderCards();
}

/** Snapshot first (instant, works offline), then network (fresh, logs to the ledger). */
async function hydrateLocation(loc: SavedLocation): Promise<void> {
  const key = locationKey(loc);

  const snap = await loadLatest(key).catch(() => undefined);
  if (snap) {
    setCardState(loc, { data: snap.data, fetchedAt: snap.fetchedAt, stale: true, error: null });
  }

  try {
    const data: ForecastData = await fetchForecast(loc);
    const fetchedAt = Date.now();
    setCardState(loc, { data, fetchedAt, stale: false, error: null });
    await saveLatest(key, data);
    // The ledger writes on the same fetch path as the display — receipts from first install.
    await logForecast({
      locationKey: key,
      name: loc.name,
      lat: loc.lat,
      lon: loc.lon,
      fetchedAt,
      sourceId: 'open-meteo',
      model: 'best_match',
      hourly: data.hourly,
      daily: data.daily,
    });
  } catch (err) {
    // A failed refresh with a snapshot on screen is not an error state — the badge already
    // says "cached". Only surface the failure when there is nothing at all to show.
    if (!snap) {
      setCardState(loc, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function refreshAll(): void {
  for (const loc of locations) void hydrateLocation(loc);
}

// ---------------------------------------------------------------- wind layer

// Registered like any other layer: the texture is derived from NOMADS GFS, so the
// denylist/flag door and the contract's licensing row both apply to it.
registerLayer('wind-particles', 'nomads-gfs');

const windCanvas = document.getElementById('wind') as HTMLCanvasElement;
const windLayer = new WindLayer(map, windCanvas);
const windToggle = document.getElementById('wind-toggle') as HTMLButtonElement;
const WIND_PREF_KEY = 'aether.wind';

async function setWind(on: boolean): Promise<void> {
  try {
    if (on) await windLayer.start();
    else windLayer.stop();
  } catch (err) {
    windToggle.disabled = true;
    windToggle.title = err instanceof Error ? err.message : String(err);
    return;
  }
  windToggle.classList.toggle('is-on', windLayer.isRunning);
  localStorage.setItem(WIND_PREF_KEY, windLayer.isRunning ? 'on' : 'off');
}

windToggle.addEventListener('click', () => void setWind(!windLayer.isRunning));

// Battery: no animation while the tab is hidden. Resume follows the saved preference.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (windLayer.isRunning) windLayer.stop();
  } else if (localStorage.getItem(WIND_PREF_KEY) === 'on') {
    void setWind(true);
  }
});

// Default: on — unless the user asked the OS for reduced motion, which a full-screen
// million-particle animation would be an obnoxious answer to.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const windPref = localStorage.getItem(WIND_PREF_KEY);
if (windPref === 'on' || (windPref === null && !reducedMotion)) void setWind(true);

// The picker chip: wind at the cursor, decoded from the same texels the shader samples.
// Desktop only — there is no hover on touch, and the phones' screen space is spoken for.
const chip = document.getElementById('wind-chip')!;
if (window.matchMedia('(hover: hover)').matches) {
  map.on('mousemove', (e) => {
    if (!windLayer.isRunning) {
      chip.hidden = true;
      return;
    }
    const s = windLayer.sampleWind(e.lngLat.lng, e.lngLat.lat);
    if (!s) {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    chip.style.left = `${e.point.x + 14}px`;
    chip.style.top = `${e.point.y + 14}px`;
    chip.innerHTML = `${s.speedMs.toFixed(1)} m/s @ ${Math.round(s.dirDeg)}°<br><span class="chip-meta">GFS ${windLayer.meta?.cycle ?? ''}</span>`;
  });
  map.on('mouseout', () => {
    chip.hidden = true;
  });
}

// ---------------------------------------------------------------- chrome

const sourcesDialog = buildSourcesDialog();
renderFooter(document.getElementById('footer')!, () => sourcesDialog.showModal());
document.getElementById('refresh')!.addEventListener('click', refreshAll);

// ---------------------------------------------------------------- boot

renderCards();
syncMarkers();
refreshAll();
setInterval(refreshAll, REFRESH_INTERVAL_MS);

if ('serviceWorker' in navigator) {
  // Relative path on purpose: resolves correctly at "/" locally and under "/<repo>/" on Pages.
  void navigator.serviceWorker.register('sw.js');
}

// Debug hook, same convention as the spike's __spike: lets the boot be verified headlessly.
(window as unknown as Record<string, unknown>)['__aether'] = {
  locations: () => locations,
  cards: () =>
    [...cardStates.values()].map((c) => ({
      name: c.loc.name,
      hasData: c.data !== null,
      stale: c.stale,
      error: c.error,
      tempNow: c.data ? c.data.current.temperature_2m : null,
    })),
  ledgerCount,
  layers: () => import('./layers/registry').then((m) => m.listLayers()),
  swState: () =>
    navigator.serviceWorker?.getRegistration().then((r) => r?.active?.state ?? 'none'),
  wind: () => ({
    running: windLayer.isRunning,
    fps: windLayer.fps,
    particles: windLayer.particleCount,
    cycle: windLayer.meta?.cycle ?? null,
    validTime: windLayer.meta?.validTime ?? null,
  }),
  /** P1 exit check: picker vs Open-Meteo GFS at the texture's valid time. */
  sampleWind: (lng: number, lat: number) => windLayer.sampleWind(lng, lat),
  /** Headless render proof — see WindLayer.debugStep. */
  windStep: (n?: number) => windLayer.debugStep(n),
};
