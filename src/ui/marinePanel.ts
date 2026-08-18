/**
 * The Marine panel — tides, sea state, waves and the moon.
 *
 * What paid boating apps put behind a subscription, assembled from the agencies that
 * collected it. The panel's spine is the same one the rest of Aether uses: say what the
 * number is, say where it came from, say how old it is, and never dress a gap as data.
 *
 * The tide strip is drawn rather than tabulated because a tide is a *shape* — you read
 * "slack in an hour" off a curve faster than off four timestamps.
 */

import { fetchBuoy, fetchTides, fetchWaves, moonState } from '../data/marine';
import type { TideEvent, TideReport } from '../data/marine';
import { fmtTemp, tempUnit } from './units';
import type { SavedLocation } from './locations';

export function buildMarineDialog(): HTMLDialogElement {
  const dlg = document.createElement('dialog');
  dlg.className = 'sources-dialog marine-dialog';
  document.body.append(dlg);
  return dlg;
}

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function countdown(ms: number): string {
  const mins = Math.round((ms - Date.now()) / 60_000);
  if (mins < 0) return `${-mins} min ago`;
  if (mins < 90) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  return `in ${h} h ${mins % 60} min`;
}

/**
 * A tide curve from the hi/lo events. Between two extremes the water follows a cosine —
 * the standard approximation ("rule of twelfths" is this curve, sampled coarsely) — which
 * is honest at the resolution a person plans a boat trip on.
 */
function tideCurve(events: TideEvent[], w: number, h: number): string {
  const now = Date.now();
  const from = now - 3 * 3600_000;
  const to = now + 24 * 3600_000;
  const win = events.filter((e) => e.ms > from - 8 * 3600_000 && e.ms < to + 8 * 3600_000);
  if (win.length < 2) return '';

  const feet = win.map((e) => e.feet);
  const lo = Math.min(...feet);
  const hi = Math.max(...feet);
  const pad = Math.max(0.3, (hi - lo) * 0.15);
  const X = (ms: number) => ((ms - from) / (to - from)) * w;
  const Y = (ft: number) => h - ((ft - (lo - pad)) / (hi + pad - (lo - pad))) * h;

  const pts: string[] = [];
  for (let i = 0; i < win.length - 1; i++) {
    const a = win[i]!;
    const b = win[i + 1]!;
    for (let s = 0; s <= 12; s++) {
      const f = s / 12;
      const ms = a.ms + (b.ms - a.ms) * f;
      // cosine interpolation between consecutive extremes
      const ft = a.feet + (b.feet - a.feet) * ((1 - Math.cos(Math.PI * f)) / 2);
      pts.push(`${X(ms).toFixed(1)},${Y(ft).toFixed(1)}`);
    }
  }
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${X(win[win.length - 1]!.ms).toFixed(1)},${h} L${X(win[0]!.ms).toFixed(1)},${h} Z`;
  const nowX = X(now).toFixed(1);

  const labels = win
    .filter((e) => e.ms >= from && e.ms <= to)
    .map(
      (e) =>
        `<text x="${X(e.ms).toFixed(1)}" y="${(Y(e.feet) + (e.type === 'H' ? -6 : 13)).toFixed(1)}"
           class="tide-lbl" text-anchor="middle">${e.type === 'H' ? '▲' : '▼'} ${hhmm(e.ms)}</text>`,
    )
    .join('');

  return `<svg viewBox="0 0 ${w} ${h + 16}" class="tide-svg" role="img"
      aria-label="Tide curve for the next 24 hours">
    <path d="${area}" class="tide-area"/>
    <path d="${line}" class="tide-line"/>
    <line x1="${nowX}" y1="0" x2="${nowX}" y2="${h}" class="tide-now"/>
    ${labels}
  </svg>`;
}

function tideSection(t: TideReport): string {
  const next = t.now.risingToward;
  const dir = next ? (next.type === 'H' ? 'rising' : 'falling') : '—';
  const headline = next
    ? `<b class="${next.type === 'H' ? 'tide-hi' : 'tide-lo'}">${dir}</b> toward
       ${next.type === 'H' ? 'high' : 'low'} ${next.feet.toFixed(1)} ft ${countdown(next.ms)}`
    : 'no upcoming tide event in the window';

  // Prediction vs measurement — the pairing no consumer boating app shows.
  let truth = '<span class="muted">this station is prediction-only (no gauge)</span>';
  if (t.observed) {
    const ageMin = Math.round((Date.now() - t.observed.ms) / 60_000);
    truth = `measured <b>${t.observed.feet.toFixed(2)} ft</b> at ${hhmm(t.observed.ms)}
      <span class="muted">(${ageMin} min ago, MLLW)</span>`;
  }

  const rows = t.events
    .filter((e) => e.ms > Date.now() - 3600_000)
    .slice(0, 4)
    .map(
      (e) => `<tr>
        <td class="${e.type === 'H' ? 'tide-hi' : 'tide-lo'}">${e.type === 'H' ? '▲ High' : '▼ Low'}</td>
        <td>${new Date(e.ms).toLocaleDateString(undefined, { weekday: 'short' })} ${hhmm(e.ms)}</td>
        <td class="num">${e.feet.toFixed(1)} ft</td>
        <td class="num muted">${countdown(e.ms)}</td>
      </tr>`,
    )
    .join('');

  return `
    <p class="marine-headline">${headline}</p>
    ${tideCurve(t.events, 520, 96)}
    <table class="receipts-table"><tbody>${rows}</tbody></table>
    <p class="marine-truth">${truth}</p>
    <p class="marine-src">NOAA CO-OPS station <b>${t.station.id}</b> — ${t.station.name},
      ${t.distanceKm} km away · heights above MLLW</p>`;
}

export async function renderMarine(
  dlg: HTMLDialogElement,
  locations: SavedLocation[],
): Promise<void> {
  dlg.innerHTML = `<button class="dialog-close" aria-label="Close">×</button>
    <h2>Marine</h2><p class="sources-intro">Reading the water…</p>`;
  dlg.querySelector('.dialog-close')?.addEventListener('click', () => dlg.close());

  const moon = moonState();
  const sections: string[] = [];

  for (const loc of locations) {
    let body = '';
    try {
      const [tides, buoy, waves] = await Promise.all([
        fetchTides(loc),
        fetchBuoy(loc).catch(() => null),
        fetchWaves(loc).catch(() => null),
      ]);
      body += tideSection(tides);

      if (buoy) {
        const o = buoy.obs;
        const bits: string[] = [];
        if (o.waterC !== null) bits.push(`water <b>${fmtTemp(o.waterC)}</b>`);
        if (o.airC !== null) bits.push(`air ${fmtTemp(o.airC)}`);
        if (o.waveM !== null) {
          const ft = (o.waveM * 3.28084).toFixed(1);
          bits.push(`seas <b>${ft} ft</b>${o.domPeriodS ? ` @ ${o.domPeriodS.toFixed(0)} s` : ''}`);
        }
        if (o.windMs !== null) {
          const kt = (o.windMs * 1.94384).toFixed(0);
          bits.push(`wind ${kt} kt${o.gustMs !== null ? ` (gust ${(o.gustMs * 1.94384).toFixed(0)})` : ''}`);
        }
        body += `<p class="marine-buoy">🛟 Buoy <b>${o.id}</b> — ${bits.join(' · ')}
          <span class="marine-src">${buoy.distanceKm} km away · observed ${buoy.ageMin} min ago
          · NDBC via the 6-hourly bake</span></p>`;
      } else {
        body += `<p class="marine-buoy muted">no reporting buoy near this location</p>`;
      }

      if (waves && !waves.dry) {
        const idx = waves.time.findIndex((t) => Date.parse(t + 'Z') > Date.now());
        const slice = waves.waveM.slice(Math.max(0, idx), Math.max(0, idx) + 24).filter((v): v is number => v !== null);
        if (slice.length > 0) {
          const maxFt = (Math.max(...slice) * 3.28084).toFixed(1);
          const nowFt = (slice[0]! * 3.28084).toFixed(1);
          body += `<p class="marine-wave">🌊 Model waves: <b>${nowFt} ft</b> now,
            peaking ${maxFt} ft in the next 24 h <span class="marine-src">Open-Meteo marine</span></p>`;
        }
      } else if (waves?.dry) {
        body += `<p class="marine-wave muted">🌊 the wave model has no water at this point — inland pin</p>`;
      }
    } catch (err) {
      body = `<p class="muted">marine data unavailable: ${err instanceof Error ? err.message : err}</p>`;
    }
    sections.push(`<h3>${loc.name}</h3>${body}`);
  }

  dlg.innerHTML = `
    <button class="dialog-close" aria-label="Close">×</button>
    <h2>Marine <span class="kp-note">${moon.glyph} ${moon.name} · ${moon.illuminatedPct}% lit</span></h2>
    <p class="sources-intro">Tide predictions and gauges from NOAA CO-OPS · sea state from NDBC
      buoys · wave model from Open-Meteo. Temperatures follow your °${tempUnit()} setting.</p>
    ${sections.join('')}
    <p class="smoke-honesty">Tide heights are predictions from harmonic constants — real water
    also answers to wind, pressure and river flow, which is exactly why the measured gauge
    reading is printed next to them rather than hidden behind them.</p>`;

  dlg.querySelector('.dialog-close')?.addEventListener('click', () => dlg.close());
}
