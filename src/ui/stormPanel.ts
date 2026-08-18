/**
 * The storm panel — *Who Was Right?* pointed at a live storm.
 *
 * Renders the Tier B storm ledger: per active storm, every public model's verified track
 * error so far, ranked, with n on every number. The map half draws truth and prediction in
 * the same frame — observed track solid, latest official forecast dashed — which is the diff
 * the incumbent's tracker draws but never scores.
 *
 * The ECMWF absence note is rendered, not buried: scoring a quietly diminished field would
 * be the kind of silent narrowing this project exists to avoid.
 */

import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import { registerLayer } from '../layers/registry';

export interface StormLedger {
  generated: string;
  note: string;
  storms: Array<{
    id: string;
    name: string;
    classification: string | null;
    intensityKt: string | null;
    pressureMb: string | null;
    position: { lat: number | null; lon: number | null };
    bestTrack: Array<{ t: string; lat: number; lon: number; kt: number | null }>;
    latestForecast: Array<{ t: string; tau: number; lat: number; lon: number; kt: number | null }>;
    scores: Array<{
      tech: string;
      label: string;
      leads: Record<string, { km: number; kt: number | null; n: number }>;
      overallKm: number | null;
      nOverall: number;
    }>;
    sentence: string | null;
    advisoryCycles: number;
  }>;
}

/** Same-origin Tier B artifact; the committed snapshot is the offline/last-known-good copy. */
export async function loadStormLedger(): Promise<StormLedger | null> {
  try {
    const r = await fetch('data/storms/ledger.json');
    if (!r.ok) return null;
    return (await r.json()) as StormLedger;
  } catch {
    return null;
  }
}

const CLASS_NAMES: Record<string, string> = {
  TD: 'Tropical depression',
  TS: 'Tropical storm',
  HU: 'Hurricane',
  MH: 'Major hurricane',
  STD: 'Subtropical depression',
  STS: 'Subtropical storm',
};

export function buildStormDialog(): HTMLDialogElement {
  const dlg = document.createElement('dialog');
  dlg.className = 'sources-dialog storm-dialog';
  document.body.append(dlg);
  return dlg;
}

export function renderStorms(dlg: HTMLDialogElement, ledger: StormLedger | null,
  onShowTrack: (stormIndex: number) => void): void {
  const close = `<button class="dialog-close" aria-label="Close">×</button>`;
  const head = `<h2>Storm ledger</h2>
    <p class="sources-intro">Every public model's forecasts for each active storm, verified
    against the observed best track so far — scored while the storm is still out there, which
    is when the answer matters.</p>`;

  if (!ledger || ledger.storms.length === 0) {
    dlg.innerHTML = `${close}${head}<p class="receipts-empty">No active storms in the NHC/CPHC
      basins right now — the ledger refreshes with each 6-hourly advisory cycle.</p>`;
    dlg.querySelector('.dialog-close')?.addEventListener('click', () => dlg.close());
    return;
  }

  const sections = ledger.storms.map((s, i) => {
    const cls = CLASS_NAMES[s.classification ?? ''] ?? s.classification ?? '';
    const leads = ['24', '48', '72'];
    const rows = s.scores
      .filter((sc) => sc.overallKm !== null)
      .map((sc, rank) => {
        const cells = leads
          .map((l) => {
            const c = sc.leads[l];
            return `<td class="num">${c ? `${c.km} <span class="muted">(${c.n})</span>` : '—'}</td>`;
          })
          .join('');
        return `<tr>
          <td>${rank === 0 ? '🥇 ' : ''}${sc.label}</td>${cells}
          <td class="num"><b>${sc.overallKm}</b> <span class="muted">(${sc.nOverall})</span></td>
        </tr>`;
      })
      .join('');

    return `<section>
      <h3>🌀 ${s.name} <span class="storm-class">${cls} · ${s.intensityKt ?? '?'} kt · ${s.pressureMb ?? '?'} mb</span></h3>
      <p class="receipts-provider">${s.advisoryCycles} advisory cycles · ${s.bestTrack.length} observed fixes ·
        updated ${ledger.generated.slice(11, 16)}Z</p>
      ${s.sentence ? `<p class="receipts-sentence">${s.sentence}</p>` : ''}
      <table class="receipts-table">
        <thead><tr><th>model</th><th>24 h</th><th>48 h</th><th>72 h</th><th>24–72 h</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="storm-units muted">mean track error, km (n) — lower is better</p>
      <button class="storm-show" data-storm="${i}">Show tracks on map</button>
    </section>`;
  });

  dlg.innerHTML = `${close}${head}${sections.join('')}
    <p class="storm-note">${ledger.note}</p>
    <p class="storm-note">Source: NOAA NHC/CPHC ATCF — public domain.</p>`;
  dlg.querySelector('.dialog-close')?.addEventListener('click', () => dlg.close());
  dlg.querySelectorAll<HTMLButtonElement>('.storm-show').forEach((btn) =>
    btn.addEventListener('click', () => {
      onShowTrack(Number(btn.dataset['storm']));
      dlg.close();
    }),
  );
}

// ------------------------------------------------------------------ map tracks

const OBS_ID = 'storm-obs';
const FCST_ID = 'storm-fcst';
let layersReady = false;

/** Draw truth (solid) and latest official forecast (dashed) — the un-drawn diff, drawn. */
export function showStormOnMap(map: MapLibreMap, ledger: StormLedger, index: number): void {
  const s = ledger.storms[index];
  if (!s) return;

  const obs = {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'LineString' as const, coordinates: s.bestTrack.map((p) => [p.lon, p.lat]) },
  };
  const fcst = {
    type: 'Feature' as const,
    properties: {},
    geometry: {
      type: 'LineString' as const,
      coordinates: s.latestForecast.map((p) => [p.lon, p.lat]),
    },
  };

  if (!layersReady) {
    registerLayer('storm-tracks', 'nhc-storms');
    map.addSource(OBS_ID, { type: 'geojson', data: obs });
    map.addSource(FCST_ID, { type: 'geojson', data: fcst });
    map.addLayer({
      id: OBS_ID, type: 'line', source: OBS_ID,
      paint: { 'line-color': '#e8edf7', 'line-width': 2.5, 'line-opacity': 0.9 },
    });
    map.addLayer({
      id: FCST_ID, type: 'line', source: FCST_ID,
      paint: {
        'line-color': '#fbbf24', 'line-width': 2.5, 'line-opacity': 0.9,
        'line-dasharray': [2, 2],
      },
    });
    layersReady = true;
  } else {
    (map.getSource(OBS_ID) as GeoJSONSource).setData(obs);
    (map.getSource(FCST_ID) as GeoJSONSource).setData(fcst);
  }

  const all = [...s.bestTrack, ...s.latestForecast];
  if (all.length > 0) {
    const lons = all.map((p) => p.lon);
    const lats = all.map((p) => p.lat);
    map.fitBounds(
      [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: 90, duration: 1200 },
    );
  }
}
