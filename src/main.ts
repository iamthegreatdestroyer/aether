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
import {
  fetchLedgerForecast,
  ledgerCount,
  loadLatest,
  logForecast,
  saveLatest,
  shouldLog,
} from './data/ledger';
import { captureObservations } from './data/observations';
import { runScorer, summarize } from './data/scorer';
import { buildReceiptsDialog, renderReceipts } from './ui/receipts';
import { buildSpaceDialog, renderSpace, stopSpacePolling } from './ui/spacePanel';
import { buildSmokeDialog, renderSmoke } from './ui/smokePanel';
import { FiresLayer } from './layers/fires';
import { isThisWeird } from './data/climatology';
import { fetchHonesty } from './data/ensemble';
import { buildConeDialog, renderCone } from './ui/coneDialog';
import { buildStormDialog, loadStormLedger, renderStorms, showStormOnMap } from './ui/stormPanel';
import { addWaypoint, debugRoute, initRoutePanel, isRouteMode } from './ui/routePanel';
import type { StormLedger } from './ui/stormPanel';
import { fetchOvation, sampleAurora } from './data/space';
import { balloonTruth } from './data/sondes';
import { registerLayer } from './layers/registry';
import { renderCard } from './ui/forecastCard';
import type { CardState } from './ui/forecastCard';
import { addLocation, loadLocations, locationKey, removeLocation } from './ui/locations';
import type { SavedLocation } from './ui/locations';
import { buildSourcesDialog, renderFooter } from './ui/attribution';
import { WIND_LEVELS, WindLayer } from './particles/windLayer';
import type { WindLevelId } from './particles/windLayer';
import { RadarLayer } from './layers/radar';
import { SatelliteLayer } from './layers/satellite';
import { DivergenceLayer } from './layers/divergence';
import { blockedSources, initNativeTransport, hasNativeTransport, setBlockedSources } from './data/fetcher';

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

// P6: under the desktop shell, arm the Rust-side transport before anything fetches, then
// prove the native paths by writing a self-check file the outside world can read (the G0.6
// lesson: a GUI process's stdout is a dead end — files are the truth channel).
const nativeReady = initNativeTransport().then(async (native) => {
  if (!native) return false;
  try {
    const [{ invoke }, { fetchKpSeries }, { captureMetar }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('./data/space'),
      import('./data/observations'),
    ]);
    const kp = await fetchKpSeries();
    // The second cheque: London sits outside NWS coverage, so its ledger truth depends on
    // this exact path. captureMetar only reads — the obs store is untouched by a self-check.
    const london = { id: 'native-check', name: 'London', lat: 51.5072, lon: -0.1276 };
    const metarObs = await captureMetar(
      london,
      new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    ).catch(() => []);
    const latestObs = [...metarObs].sort((a, b) => a.hour.localeCompare(b.hour)).pop() ?? null;
    await invoke('report', {
      payload: JSON.stringify({
        at: new Date().toISOString(),
        nativeTransport: true,
        kpSource: kp.sourceLabel,
        kpOfficial: kp.official,
        kpLatest: kp.readings[kp.readings.length - 1] ?? null,
        metarStation: latestObs?.station ?? null,
        metarHours: metarObs.length,
        metarLatest: latestObs
          ? { hour: latestObs.hour, temperatureC: latestObs.temperatureC, windSpeedMs: latestObs.windSpeedMs }
          : null,
      }),
    });
  } catch (err) {
    console.warn('[native-check]', err);
  }
  return true;
});

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
  // Route mode captures clicks as waypoints; location-adding resumes when it's off.
  if (isRouteMode()) {
    addWaypoint(e.lngLat.lat, e.lngLat.lng);
    return;
  }
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

const coneDialog = buildConeDialog();

function openCone(loc: SavedLocation): void {
  coneDialog.showModal();
  void renderCone(coneDialog, loc, cardStates.get(loc.id)?.data ?? null);
}

function renderCards(): void {
  rail.replaceChildren(
    ...locations.map((loc) =>
      renderCard(
        cardStates.get(loc.id) ?? { loc, data: null, fetchedAt: null, stale: false, error: null, weirdness: null, honesty: null },
        handleRemove,
        openCone,
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
    weirdness: null,
    honesty: null,
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
    // The ledger writes on the same fetch path as the display — receipts from first
    // install. v2: a separate hourly-only multi-model fetch (UTC), made only when the
    // hourly guard will actually accept the entry, so the extra call never runs for spam.
    if (shouldLog(key, fetchedAt)) {
      const models = await fetchLedgerForecast(loc);
      await logForecast({
        locationKey: key,
        name: loc.name,
        lat: loc.lat,
        lon: loc.lon,
        fetchedAt,
        sourceId: 'open-meteo',
        models,
      });
    }
    // Truth side: capture whatever observations exist for this location, then score.
    await captureObservations(loc).catch(() => []);
    // "Is this weird?" — today's forecast high/low vs 85 years of ERA5 at this point.
    // First call per location downloads ~162 KB of climatology; every call after reads
    // IndexedDB. Failure leaves the chip absent, never the card broken.
    try {
      const d0 = data.daily;
      const date = d0.time[0];
      const hi = d0.temperature_2m_max[0];
      const lo = d0.temperature_2m_min[0];
      if (date !== undefined && hi !== undefined && lo !== undefined) {
        const weirdness = await isThisWeird(loc, date, hi, lo);
        setCardState(loc, { weirdness });
      }
    } catch (err) {
      console.warn('[weird]', err);
    }
    // Honesty labels: per-day predictability from real ensemble spread. 3 h cached; failure
    // leaves the badges absent, never the card broken.
    try {
      const honesty = await fetchHonesty(loc);
      setCardState(loc, { honesty });
    } catch (err) {
      console.warn('[honesty]', err);
    }
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
  // Score after the hydrates have had a chance to capture fresh truth. Fire-and-forget on a
  // delay rather than awaited — scoring is bookkeeping, never in the render path.
  window.setTimeout(() => void runScorer(), 20_000);
}

// ------------------------------------------------------- AI-vs-physics divergence

const divergence = new DivergenceLayer(map);
const divToggle = document.getElementById('div-toggle') as HTMLButtonElement;
const divLegend = document.getElementById('div-legend') as HTMLDivElement;

function renderDivLegend(): void {
  const s = divergence.state;
  divLegend.hidden = !s.enabled;
  divToggle.classList.toggle('is-on', s.enabled);
  if (!s.enabled) return;
  const chips = s.leads
    .map((l) => `<button class="div-lead ${l === s.lead ? 'is-on' : ''}" data-lead="${l}">+${l}h</button>`)
    .join('');
  divLegend.innerHTML = `
    <div class="div-title">🤖 AI vs physics — |IFS − AIFS| 2 m temp · cycle ${s.cycle?.slice(9, 14) ?? ''}</div>
    <div class="div-row">${chips}
      <span class="div-scale"><i></i>0.5° → 8°+</span>
      ${s.stats ? `<span class="div-stats">${s.stats.pctOver2C}% of globe >2° apart · max ${s.stats.max}°</span>` : ''}
    </div>
    <div class="div-note">Not an error map — a humility map. Where it lights up, nobody knows yet
      which philosophy is right; hold the forecast loosely. ${'' /* attribution below */}</div>
    <div class="div-attr">${s.attribution ?? ''}</div>`;
  divLegend.querySelectorAll<HTMLButtonElement>('.div-lead').forEach((b) =>
    b.addEventListener('click', () => divergence.setLead(Number(b.dataset['lead']))),
  );
}
divergence.onChange = renderDivLegend;

divToggle.addEventListener('click', () => {
  if (divergence.state.enabled) divergence.disable();
  else {
    whenStyleReady(() => {
      divergence.enable().catch((err) => {
        divToggle.title = err instanceof Error ? err.message : String(err);
        console.warn('[divergence]', err);
      });
    });
  }
});

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
  syncWindLevels();
}

windToggle.addEventListener('click', () => void setWind(!windLayer.isRunning));

// Altitude switcher (tour idea #4's sibling): chips appear only while the layer runs —
// a level choice with no particles on screen would be a dead control.
const WIND_LEVEL_KEY = 'aether.windlevel';
const windLevels = document.createElement('div');
windLevels.id = 'wind-levels';
windLevels.hidden = true;
for (const l of WIND_LEVELS) {
  const b = document.createElement('button');
  b.textContent = l.label;
  b.title = l.title;
  b.dataset['level'] = l.id;
  b.addEventListener('click', () => {
    void windLayer.setLevel(l.id).then(() => {
      localStorage.setItem(WIND_LEVEL_KEY, l.id);
      syncWindLevels();
    });
  });
  windLevels.append(b);
}
windToggle.after(windLevels);

function syncWindLevels(): void {
  windLevels.hidden = !windLayer.isRunning;
  for (const b of windLevels.querySelectorAll('button')) {
    b.classList.toggle('is-on', b.dataset['level'] === windLayer.level);
  }
}

{
  const saved = localStorage.getItem(WIND_LEVEL_KEY) as WindLevelId | null;
  if (saved && WIND_LEVELS.some((l) => l.id === saved)) void windLayer.setLevel(saved);
}

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

// ---------------------------------------------------------------- radar + satellite

const radar = new RadarLayer(map);
const satellite = new SatelliteLayer(map);
const radarToggle = document.getElementById('radar-toggle') as HTMLButtonElement;
const satToggle = document.getElementById('sat-toggle') as HTMLButtonElement;
const timeline = document.getElementById('timeline') as HTMLDivElement;
const tlPlay = document.getElementById('tl-play') as HTMLButtonElement;
const tlScrub = document.getElementById('tl-scrub') as HTMLInputElement;
const tlLabel = document.getElementById('tl-label') as HTMLSpanElement;
const tlProvider = document.getElementById('tl-provider') as HTMLSpanElement;

const RADAR_PREF = 'aether.radar';
const SAT_PREF = 'aether.sat';

function renderTimeline(): void {
  const s = radar.state;
  timeline.hidden = !s.enabled;
  radarToggle.classList.toggle('is-on', s.enabled);
  if (!s.enabled) return;

  tlScrub.max = String(Math.max(0, s.frames.length - 1));
  tlScrub.value = String(s.frameIndex);
  tlPlay.textContent = s.playing ? '⏸' : '▶';

  const frame = s.frames[s.frameIndex];
  if (frame) {
    const t = new Date(frame.time * 1000).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    tlLabel.textContent = frame.future ? `+${t}` : t;
    tlLabel.classList.toggle('is-future', frame.future);
  }
  // The provider badge is the failover chain's honesty surface: amber when running on a
  // fallback, so degraded coverage (RainViewer zoom cap, IEM CONUS-only) is never silent.
  tlProvider.textContent = s.providerLabel;
  tlProvider.classList.toggle('is-fallback', s.provider !== 'librewxr');
}
radar.onChange = renderTimeline;

async function setRadar(on: boolean): Promise<void> {
  try {
    if (on) await radar.enable();
    else radar.disable();
    localStorage.setItem(RADAR_PREF, on ? 'on' : 'off');
  } catch (err) {
    radarToggle.title = err instanceof Error ? err.message : String(err);
    radarToggle.classList.add('is-error');
    console.error('[radar]', err);
  }
  renderTimeline();
}

function setSat(on: boolean): void {
  try {
    if (on) satellite.enable();
    else satellite.disable();
    satToggle.classList.toggle('is-on', satellite.isEnabled);
    satToggle.title = satellite.date
      ? `VIIRS true color, ${satellite.date} (daily imagery lags ~1 day)`
      : 'Toggle the satellite layer';
    localStorage.setItem(SAT_PREF, on ? 'on' : 'off');
  } catch (err) {
    console.error('[satellite]', err);
  }
}

radarToggle.addEventListener('click', () => void setRadar(!radar.state.enabled));
satToggle.addEventListener('click', () => setSat(!satellite.isEnabled));
tlPlay.addEventListener('click', () => radar.setPlaying(!radar.state.playing));
tlScrub.addEventListener('input', () => {
  radar.setPlaying(false);
  radar.setFrame(Number(tlScrub.value));
});

// Layers wait for the STYLE, not the map's `load` event — deliberately. `load` fires after
// the first render, and rendering requires the tab to be compositing; a backgrounded or
// hidden tab would never enable the radar at all. `style.load` is network-driven and fires
// regardless. (Found because the headless verification hung exactly there.)
function whenStyleReady(fn: () => void): void {
  if (map.isStyleLoaded()) fn();
  else map.once('style.load', fn);
}
whenStyleReady(() => {
  if (localStorage.getItem(RADAR_PREF) !== 'off') void setRadar(true);
  if (localStorage.getItem(SAT_PREF) === 'on') setSat(true);
});

// ---------------------------------------------------------------- chrome

const sourcesDialog = buildSourcesDialog();
renderFooter(document.getElementById('footer')!, () => sourcesDialog.showModal());
document.getElementById('refresh')!.addEventListener('click', refreshAll);

const receiptsDialog = buildReceiptsDialog();
document.getElementById('receipts-toggle')!.addEventListener('click', () => {
  void renderReceipts(receiptsDialog, locations).then(() => receiptsDialog.showModal());
});

initRoutePanel(
  map,
  document.getElementById('route-bar')!,
  document.getElementById('route-toggle') as HTMLButtonElement,
);

let stormLedger: StormLedger | null = null;
const stormDialog = buildStormDialog();
document.getElementById('storms-toggle')!.addEventListener('click', () => {
  stormDialog.showModal();
  void loadStormLedger().then((ledger) => {
    stormLedger = ledger;
    renderStorms(stormDialog, ledger, (i) => {
      if (stormLedger) showStormOnMap(map, stormLedger, i);
    });
  });
});

const firesLayer = new FiresLayer(map);
const smokeDialog = buildSmokeDialog();
const smokeToggle = document.getElementById('smoke-toggle') as HTMLButtonElement;
smokeToggle.addEventListener('click', () => {
  smokeDialog.showModal();
  void renderSmoke(smokeDialog, locations, firesLayer.isEnabled, () => {
    if (firesLayer.isEnabled) firesLayer.disable();
    else void firesLayer.enable().catch((err) => console.warn('[fires]', err));
    smokeToggle.classList.toggle('is-on', firesLayer.isEnabled);
  });
});

const spaceDialog = buildSpaceDialog();
document.getElementById('space-toggle')!.addEventListener('click', () => {
  spaceDialog.showModal(); // open immediately with the loading state…
  void renderSpace(spaceDialog, locations); // …then fill as the chain arrives
});
spaceDialog.addEventListener('close', stopSpacePolling);

// ---------------------------------------------------------------- boot

renderCards();
syncMarkers();
refreshAll();
setInterval(refreshAll, REFRESH_INTERVAL_MS);

if ('serviceWorker' in navigator) {
  if ('__TAURI_INTERNALS__' in window) {
    // Under the desktop shell the assets ship INSIDE the exe — a service worker adds zero
    // offline value and inserts a stale-serving layer between app updates and the webview.
    // Found the hard way (2026-08-18): a P6-era SW kept serving the previous bundle after a
    // rebuild. Unregister heals installs that ran an SW-registering build.
    void navigator.serviceWorker
      .getRegistrations()
      .then((rs) => Promise.all(rs.map((r) => r.unregister())));
  } else {
    // Relative path on purpose: resolves correctly at "/" locally and under "/<repo>/" on Pages.
    void navigator.serviceWorker.register('sw.js');
  }
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
  weird: (i = 0) => {
    const loc = locations[i];
    const c = loc && cardStates.get(loc.id);
    if (!loc || !c?.data) return Promise.resolve(null);
    return isThisWeird(
      loc,
      c.data.daily.time[0]!,
      c.data.daily.temperature_2m_max[0]!,
      c.data.daily.temperature_2m_min[0]!,
    );
  },
  storms: () => loadStormLedger(),
  divergence: () => divergence.state,
  native: () => nativeReady.then(() => hasNativeTransport()),
  divergenceOn: () => divergence.enable().then(() => divergence.state),
  cone: (i = 0) => {
    const loc = locations[i];
    if (!loc) return Promise.resolve(null);
    openCone(loc);
    return import('./data/ensemble').then((m2) => m2.fetchCone(loc));
  },
  route: (wps: Array<{ lat: number; lon: number }>, mode = 'car', departH = 0) =>
    debugRoute(wps, mode as never, departH),
  honesty: (i = 0) => {
    const loc = locations[i];
    return loc ? fetchHonesty(loc) : Promise.resolve(null);
  },
  /** Headless render proof — see WindLayer.debugStep. */
  windStep: (n?: number) => windLayer.debugStep(n),
  radar: () => radar.state,
  score: () => runScorer(),
  summary: (lk: string) => summarize(lk),
  captureObs: (i = 0) => {
    const loc = locations[i];
    return loc ? captureObservations(loc) : Promise.resolve([]);
  },
  /** P4 verification: aurora probability anywhere (loads OVATION on first call). */
  auroraAt: (lat: number, lon: number) => fetchOvation().then(() => sampleAurora(lat, lon)),
  balloonTruth: (i = 0) => {
    const loc = locations[i];
    return loc ? balloonTruth(loc) : Promise.resolve(null);
  },
  radarSetFrame: (i: number) => radar.setFrame(i),
  radarRefresh: () => radar.refresh(),
  satellite: () => ({ enabled: satellite.isEnabled, date: satellite.date }),
  /** Dev outage simulation for the failover exit test: block(['librewxr']), then radarRefresh(). */
  block: (ids: string[]) => {
    setBlockedSources(ids);
    return [...blockedSources()];
  },
  mapLayers: () =>
    map.getStyle().layers.filter((l) => l.id.startsWith('radar-') || l.id === 'satellite')
      .map((l) => ({
        id: l.id,
        opacity: map.getPaintProperty(l.id, 'raster-opacity'),
      })),
};
