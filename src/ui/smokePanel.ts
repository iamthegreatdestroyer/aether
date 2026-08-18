/**
 * The Smoke panel — "is anything upwind of me burning?"
 *
 * Three data planes, all labelled with their age and their limits: FIRMS fire clusters
 * (6-hourly cron, 24 h window), the surface wind texture sampled AT each fire (a ray test,
 * not a plume model — the footer says so), and measured PM2.5 as the ground truth.
 */

import { assessSmoke, compass } from '../data/smoke';
import type { SmokeAssessment } from '../data/smoke';
import type { SavedLocation } from './locations';

export function buildSmokeDialog(): HTMLDialogElement {
  const dlg = document.createElement('dialog');
  dlg.className = 'sources-dialog smoke-dialog';
  document.body.append(dlg);
  return dlg;
}

function verdictHtml(a: SmokeAssessment): string {
  if (a.firesWithinKm === 0) {
    return `<p class="smoke-verdict smoke-clear">no VIIRS fire detections within ${a.radiusKm} km in the last 24 h</p>`;
  }
  if (a.anyToward) {
    return `<p class="smoke-verdict smoke-warn">🔥 ${a.firesWithinKm} fire cluster${a.firesWithinKm > 1 ? 's' : ''} within ${a.radiusKm} km — at least one has surface wind pointed your way</p>`;
  }
  return `<p class="smoke-verdict">🔥 ${a.firesWithinKm} fire cluster${a.firesWithinKm > 1 ? 's' : ''} within ${a.radiusKm} km — none with surface wind pointed your way right now</p>`;
}

function threatRows(a: SmokeAssessment): string {
  if (a.top.length === 0) return '';
  const rows = a.top
    .map((t) => {
      const dirWord = { toward: '→ toward you', glancing: '↝ glancing', away: '↛ away' }[t.verdict];
      const cls = { toward: 'smoke-toward', glancing: 'smoke-glancing', away: 'smoke-away' }[t.verdict];
      return `<tr>
        <td>${t.distanceKm} km ${compass(t.bearingFromYou)}</td>
        <td class="num">${t.frp.toFixed(0)} MW · ${t.n} px</td>
        <td class="num">${t.windAtFireMs} m/s</td>
        <td class="${cls}">${dirWord} (${t.offAxisDeg}° off-axis)</td>
      </tr>`;
    })
    .join('');
  return `<table class="receipts-table"><thead>
    <tr><th>fire (from you)</th><th>intensity</th><th>wind at fire</th><th>ray test</th></tr>
    </thead><tbody>${rows}</tbody></table>`;
}

function pmHtml(a: SmokeAssessment): string {
  if (!a.pm) return `<span class="muted">PM2.5: no citizen stations near enough</span>`;
  const level =
    a.pm.pm25 <= 12 ? ['good', 'pm-good'] : a.pm.pm25 <= 35 ? ['moderate', 'pm-mod'] : a.pm.pm25 <= 55 ? ['unhealthy for sensitive groups', 'pm-usg'] : ['unhealthy', 'pm-bad'];
  return `PM2.5 now: <b class="${level[1]}">${a.pm.pm25.toFixed(0)} µg/m³</b> (${level[0]}) · median of ${a.pm.stations} citizen sensors`;
}

export async function renderSmoke(
  dlg: HTMLDialogElement,
  locations: SavedLocation[],
  firesShown: boolean,
  onToggleFires: () => void,
): Promise<void> {
  dlg.innerHTML = `<button class="dialog-close" aria-label="Close">×</button>
    <h2>Smoke story</h2><p class="sources-intro">Reading the fire map…</p>`;
  dlg.querySelector('.dialog-close')?.addEventListener('click', () => dlg.close());

  const sections: string[] = [];
  let meta: SmokeAssessment | null = null;
  for (const loc of locations) {
    try {
      const a = await assessSmoke(loc);
      meta = a;
      sections.push(`<h3>${loc.name}</h3>${verdictHtml(a)}${threatRows(a)}<p class="smoke-pm">${pmHtml(a)}</p>`);
    } catch (err) {
      sections.push(
        `<h3>${loc.name}</h3><p class="muted">smoke assessment failed: ${err instanceof Error ? err.message : err}</p>`,
      );
    }
  }

  dlg.innerHTML = `
    <button class="dialog-close" aria-label="Close">×</button>
    <h2>Smoke story</h2>
    <p class="sources-intro">NASA FIRMS · VIIRS 24 h${meta ? ` · built ${meta.firesBuiltAt.slice(0, 16).replace('T', ' ')}Z` : ''} · wind valid ${meta ? meta.windValidTime.slice(0, 13) + 'Z' : '—'}</p>
    <button id="smoke-toggle-fires" class="smoke-fires-btn">${firesShown ? 'Hide' : 'Show'} fire dots on the map</button>
    ${sections.join('')}
    <p class="smoke-honesty">The ray test samples SURFACE wind at each fire — it is not a plume model.
    Smoke rides winds aloft, pools in valleys, and outlives its fire; the PM2.5 line is the measured truth.</p>`;

  dlg.querySelector('.dialog-close')?.addEventListener('click', () => dlg.close());
  dlg.querySelector('#smoke-toggle-fires')?.addEventListener('click', () => {
    onToggleFires();
    const b = dlg.querySelector('#smoke-toggle-fires');
    if (b) b.textContent = b.textContent!.startsWith('Show') ? 'Hide fire dots on the map' : 'Show fire dots on the map';
  });
}
