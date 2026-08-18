/**
 * The Trails panel — nearby trails, with the weather where the trail actually is.
 *
 * A trail app tells you the trail exists. Aether's whole argument is fusion, so this one
 * answers the question a person actually has before walking out the door: is it going to be
 * unbearable out there, and is anything in force over it? One multi-location Open-Meteo call
 * covers every trail listed (the trajectory sampler's trick), so the weather column costs a
 * single request no matter how many trails come back.
 */

import { fetchElevationM, fetchTrails, lengthLabel, trailKindGlyph } from '../data/trails';
import type { Trail } from '../data/trails';
import { fetchAlertsForPoint, worst } from '../data/alerts';
import { fetchJson } from '../data/fetcher';
import { source } from '../data/sources.mjs';
import { fmtTemp } from './units';
import type { SavedLocation } from './locations';

export function buildTrailsDialog(): HTMLDialogElement {
  const dlg = document.createElement('dialog');
  dlg.className = 'sources-dialog trails-dialog';
  document.body.append(dlg);
  return dlg;
}

interface TrailWeather {
  tempC: number | null;
  apparentC: number | null;
  windKmh: number | null;
  precipProb: number | null;
}

/** One request for every trail: comma-separated coordinates return an ordered array. */
async function weatherForTrails(trails: Trail[]): Promise<TrailWeather[]> {
  if (trails.length === 0) return [];
  const u = new URL(source('open-meteo').baseUrl!);
  u.searchParams.set('latitude', trails.map((t) => t.lat.toFixed(4)).join(','));
  u.searchParams.set('longitude', trails.map((t) => t.lon.toFixed(4)).join(','));
  u.searchParams.set('current', 'temperature_2m,apparent_temperature,wind_speed_10m,precipitation_probability');
  u.searchParams.set('timezone', 'auto');
  const raw = await fetchJson<unknown>('open-meteo', u.toString());
  const arr = Array.isArray(raw) ? raw : [raw];
  return trails.map((_, i) => {
    const c = (arr[i] as { current?: Record<string, number> } | undefined)?.current;
    return {
      tempC: c?.['temperature_2m'] ?? null,
      apparentC: c?.['apparent_temperature'] ?? null,
      windKmh: c?.['wind_speed_10m'] ?? null,
      precipProb: c?.['precipitation_probability'] ?? null,
    };
  });
}

export async function renderTrails(
  dlg: HTMLDialogElement,
  locations: SavedLocation[],
): Promise<void> {
  dlg.innerHTML = `<button class="dialog-close" aria-label="Close">×</button>
    <h2>Trails</h2><p class="sources-intro">Asking OpenStreetMap what is nearby…</p>`;
  dlg.querySelector('.dialog-close')?.addEventListener('click', () => dlg.close());

  const loc = locations[0];
  if (!loc) {
    dlg.innerHTML += '<p class="muted">No saved locations.</p>';
    return;
  }

  let body = '';
  try {
    const trails = (await fetchTrails(loc)).slice(0, 12);
    if (trails.length === 0) {
      body = `<p class="muted">No named trails within 15 km of ${loc.name} in OpenStreetMap.
        That is a real answer — and if you know one that is missing, OSM is editable by anyone.</p>`;
    } else {
      const [wx, alert, elev] = await Promise.all([
        weatherForTrails(trails).catch(() => [] as TrailWeather[]),
        fetchAlertsForPoint(loc).then(worst).catch(() => null),
        fetchElevationM(loc.lat, loc.lon).catch(() => null),
      ]);

      const rows = trails
        .map((t, i) => {
          const w = wx[i];
          const feels =
            w?.apparentC != null
              ? `${fmtTemp(w.apparentC)}${w.tempC != null && Math.abs(w.apparentC - w.tempC) >= 2 ? ` <span class="muted">(air ${fmtTemp(w.tempC)})</span>` : ''}`
              : '—';
          return `<tr>
            <td>${trailKindGlyph(t.kind)} ${t.name}</td>
            <td class="num">${lengthLabel(t.lengthM)}</td>
            <td class="num">${t.distanceKm} km</td>
            <td>${t.surface ?? '<span class="muted">unsurveyed</span>'}</td>
            <td class="num">${feels}</td>
            <td class="num">${w?.windKmh != null ? Math.round(w.windKmh) + ' km/h' : '—'}</td>
          </tr>`;
        })
        .join('');

      const warn = alert
        ? `<p class="alert-banner ${'alert-' + alert.severity.toLowerCase()}">
             <b>⚠ ${alert.event}</b> in force over this area — check before heading out.</p>`
        : '';

      body = `${warn}
        <table class="receipts-table">
          <thead><tr><th>trail</th><th>length</th><th>from you</th><th>surface</th>
            <th>feels like</th><th>wind</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="marine-src">${trails.length} named trails within 15 km of ${loc.name}
          ${elev !== null ? `· you are at ${elev} m elevation (USGS 3DEP)` : ''}
          · lengths summed across OSM way segments sharing a name</p>`;
    }
  } catch (err) {
    body = `<p class="muted">trail lookup failed: ${err instanceof Error ? err.message : err}</p>`;
  }

  dlg.innerHTML = `
    <button class="dialog-close" aria-label="Close">×</button>
    <h2>Trails near ${loc.name}</h2>
    <p class="sources-intro">Trails from OpenStreetMap (ODbL) · elevation from USGS 3DEP ·
      conditions sampled AT each trail, not at your pin — one request covers them all.</p>
    ${body}
    <p class="smoke-honesty">This is not an offline map pack, which is the thing those
    subscriptions are really selling. It is the half they do not sell: what the weather is
    doing where the trail actually is. Unnamed ways are omitted — OSM is full of desire lines
    and driveway spurs tagged as paths.</p>`;

  dlg.querySelector('.dialog-close')?.addEventListener('click', () => dlg.close());
}
