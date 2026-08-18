/**
 * The Confidence Cone — model disagreement rendered AS the forecast (proposal concept #5).
 *
 * Two ensembles drawn as translucent bands over seven days: GEFS (31 members, blue) and
 * ECMWF ENS (51 members, amber), p10–p90 with medians, min/max as faint whiskers, and the
 * single deterministic number the card shows overlaid as a white dashed line — so the chart's
 * quiet argument is visible at a glance: *the confident-looking number you were given is one
 * path through a widening cone.* A rain-agreement strip runs underneath.
 *
 * Hand-built SVG, zero dependencies — the same instinct as the particle engine: this chart
 * is ~120 lines and a library would be the heavier artifact.
 */

import { fetchCone } from '../data/ensemble';
import type { ConeData, HourlyBand } from '../data/ensemble';
import type { ForecastData } from '../data/openmeteo';
import type { SavedLocation } from './locations';

const W = 660;
const H = 240;
const RAIN_H = 26;
const PAD = { l: 34, r: 10, t: 12, b: 20 };

export function buildConeDialog(): HTMLDialogElement {
  const dlg = document.createElement('dialog');
  dlg.className = 'sources-dialog cone-dialog';
  document.body.append(dlg);
  return dlg;
}

function path(xs: number[], ys: number[]): string {
  let d = '';
  for (let i = 0; i < xs.length; i++) {
    if (Number.isNaN(ys[i]!)) continue;
    d += `${d === '' ? 'M' : 'L'}${xs[i]!.toFixed(1)},${ys[i]!.toFixed(1)}`;
  }
  return d;
}

function bandPath(xs: number[], top: number[], bot: number[]): string {
  const up = path(xs, top);
  const down = [...xs.keys()].reverse()
    .filter((i) => !Number.isNaN(bot[i]!))
    .map((i) => `L${xs[i]!.toFixed(1)},${bot[i]!.toFixed(1)}`)
    .join('');
  return `${up}${down}Z`;
}

export async function renderCone(
  dlg: HTMLDialogElement,
  loc: SavedLocation,
  card: ForecastData | null,
): Promise<void> {
  dlg.innerHTML = `<button class="dialog-close" aria-label="Close">×</button>
    <h2>Confidence cone — ${loc.name}</h2><p class="sources-intro">Loading ensembles…</p>`;
  dlg.querySelector('.dialog-close')?.addEventListener('click', () => dlg.close());

  let cone: ConeData;
  try {
    cone = await fetchCone(loc);
  } catch (err) {
    dlg.querySelector('.sources-intro')!.textContent =
      `ensembles unavailable: ${err instanceof Error ? err.message : err}`;
    return;
  }

  const n = cone.time.length;
  const xs = [...Array(n).keys()].map((i) => PAD.l + ((W - PAD.l - PAD.r) * i) / (n - 1));

  // Y domain from every band present, padded a degree each way.
  const allVals: number[] = [];
  for (const b of [cone.gefs, cone.ens]) {
    if (b) allVals.push(...b.min.filter((v) => !Number.isNaN(v)), ...b.max.filter((v) => !Number.isNaN(v)));
  }
  if (card) allVals.push(...card.hourly.temperature_2m.slice(0, n));
  if (allVals.length === 0) {
    dlg.querySelector('.sources-intro')!.textContent = 'no ensemble data for this point';
    return;
  }
  const yMin = Math.floor(Math.min(...allVals)) - 1;
  const yMax = Math.ceil(Math.max(...allVals)) + 1;
  const Y = (v: number) =>
    Number.isNaN(v) ? NaN : PAD.t + (H - PAD.t - PAD.b) * (1 - (v - yMin) / (yMax - yMin));

  const bandSvg = (b: HourlyBand | null, fill: string, stroke: string): string =>
    b
      ? `<path d="${bandPath(xs, b.p10.map(Y), b.p90.map(Y))}" fill="${fill}" stroke="none"/>
         <path d="${path(xs, b.min.map(Y))}" stroke="${stroke}" stroke-opacity="0.25" fill="none" stroke-width="1"/>
         <path d="${path(xs, b.max.map(Y))}" stroke="${stroke}" stroke-opacity="0.25" fill="none" stroke-width="1"/>
         <path d="${path(xs, b.median.map(Y))}" stroke="${stroke}" fill="none" stroke-width="1.8"/>`
      : '';

  // Day boundaries + labels.
  let grid = '';
  for (let i = 0; i < n; i++) {
    if (cone.time[i]!.endsWith('T00:00') && i > 0) {
      grid += `<line x1="${xs[i]}" y1="${PAD.t}" x2="${xs[i]}" y2="${H - PAD.b}" stroke="rgba(255,255,255,0.08)"/>`;
    }
    if (cone.time[i]!.endsWith('T12:00')) {
      const day = new Date(`${cone.time[i]!.slice(0, 10)}T12:00`).toLocaleDateString(undefined, { weekday: 'short' });
      grid += `<text x="${xs[i]}" y="${H - 6}" text-anchor="middle" class="cone-axis">${day}</text>`;
    }
  }
  for (let v = Math.ceil(yMin / 5) * 5; v <= yMax; v += 5) {
    grid += `<line x1="${PAD.l}" y1="${Y(v)}" x2="${W - PAD.r}" y2="${Y(v)}" stroke="rgba(255,255,255,0.06)"/>
      <text x="${PAD.l - 5}" y="${Y(v) + 3}" text-anchor="end" class="cone-axis">${v}°</text>`;
  }

  const det = card
    ? `<path d="${path(xs, card.hourly.temperature_2m.slice(0, n).map((v) => Y(v)))}"
         stroke="#e8edf7" stroke-dasharray="4 3" fill="none" stroke-width="1.4" stroke-opacity="0.9"/>`
    : '';

  const rain = cone.wetFracGefs
    .map((f, i) => {
      if (f === 0 || i >= n) return '';
      const x = xs[i]!;
      const w2 = (W - PAD.l - PAD.r) / n;
      return `<rect x="${(x - w2 / 2).toFixed(1)}" y="${H + 2 + (1 - f) * RAIN_H}" width="${w2.toFixed(1)}"
        height="${(f * RAIN_H).toFixed(1)}" fill="rgba(106,169,255,${0.25 + 0.5 * f})"/>`;
    })
    .join('');

  dlg.innerHTML = `
    <button class="dialog-close" aria-label="Close">×</button>
    <h2>Confidence cone — ${loc.name}</h2>
    <p class="sources-intro">Model disagreement <i>is</i> the forecast: the wider the band, the
      less anyone knows. The dashed white line is the single number the card shows you.</p>
    <svg viewBox="0 0 ${W} ${H + RAIN_H + 6}" class="cone-svg" role="img"
      aria-label="Ensemble temperature bands for ${loc.name}">
      ${grid}
      ${bandSvg(cone.gefs, 'rgba(106,169,255,0.18)', '#6aa9ff')}
      ${bandSvg(cone.ens, 'rgba(251,191,36,0.15)', '#fbbf24')}
      ${det}
      ${rain}
    </svg>
    <div class="cone-legend">
      ${cone.gefs ? `<span><i class="sw-gefs"></i> GEFS p10–p90 (${cone.gefs.members} members)</span>` : ''}
      ${cone.ens ? `<span><i class="sw-ens"></i> ECMWF ENS p10–p90 (${cone.ens.members} members)</span>` : ''}
      ${card ? '<span><i class="sw-det"></i> deterministic (what the card shows)</span>' : ''}
      <span><i class="sw-rain"></i> GEFS members with rain</span>
    </div>`;
  dlg.querySelector('.dialog-close')?.addEventListener('click', () => dlg.close());
}
