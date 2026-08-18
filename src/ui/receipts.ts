/**
 * "Who Was Right?" — the receipts panel.
 *
 * The market's #1 complaint pattern is accuracy distrust, and no consumer app shows
 * receipts (ForecastWatch is paid B2B; Windy's comparison is single-model). This panel is
 * the answer the proposal bet the product on: per location, per model, per lead bucket —
 * MAE, signed bias in plain language, sample count ALWAYS visible. Small-n is stated, not
 * hidden: three scored hours saying "ECMWF leads (n=3)" is a receipt, not a verdict, and
 * the panel says which.
 */

import { fmtDeltaSigned, fmtDeltaUnit } from './units';
import { summarize } from '../data/scorer';
import { obsProviderLabel } from '../data/observations';
import { locationKey } from './locations';
import type { SavedLocation } from './locations';

function biasSentence(label: string, biasC: number): string {
  if (Math.abs(biasC) < 0.3) return `${label} runs true here`;
  const dir = biasC > 0 ? 'warm' : 'cold';
  return `${label} runs ${fmtDeltaUnit(Math.abs(biasC))} ${dir} here`;
}

export function buildReceiptsDialog(): HTMLDialogElement {
  const dlg = document.createElement('dialog');
  dlg.className = 'sources-dialog receipts-dialog';
  document.body.append(dlg);
  return dlg;
}

export async function renderReceipts(
  dlg: HTMLDialogElement,
  locations: SavedLocation[],
): Promise<void> {
  const close = `<button class="dialog-close" aria-label="Close">×</button>`;
  const head = `<h2>Who was right?</h2>
    <p class="sources-intro">Every forecast this app shows is logged the moment it is
    fetched, then scored against real observations once the hour has passed. These are the
    receipts — they compound daily, and small samples say so.</p>`;

  const sections: string[] = [];
  for (const loc of locations) {
    const lk = locationKey(loc);
    const s = await summarize(lk);
    const provider = obsProviderLabel(lk);

    if (s.totalScores === 0) {
      sections.push(`<section><h3>${loc.name}</h3>
        <p class="receipts-empty">No scored hours yet — truth source: ${provider}.
        Receipts are accumulating; scoring begins once a forecast hour has passed.</p></section>`);
      continue;
    }

    const bucketHtml = s.buckets
      .filter((b) => b.models.length > 0)
      .map((b) => {
        const rows = b.models
          .map(
            (m, i) => `<tr>
              <td>${i === 0 ? '🥇 ' : ''}${m.label}</td>
              <td class="num">${fmtDeltaUnit(m.maeC, 2)}</td>
              <td class="num">${fmtDeltaSigned(m.biasC, 2)}</td>
              <td class="num muted">${m.n}</td>
            </tr>`,
          )
          .join('');
        const best = b.models[0];
        const sentence = best
          ? `<p class="receipts-sentence">${biasSentence(best.label, best.biasC)} —
             closest at ${b.bucket.label} (n=${best.n}).</p>`
          : '';
        return `<h4>${b.bucket.label}</h4>
          <table class="receipts-table">
            <thead><tr><th>model</th><th>MAE</th><th>bias</th><th>n</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>${sentence}`;
      })
      .join('');

    sections.push(`<section><h3>${loc.name}</h3>
      <p class="receipts-provider">truth: ${provider} · ${s.totalScores} scored hours</p>
      ${bucketHtml}</section>`);
  }

  dlg.innerHTML = close + head + sections.join('');
  dlg.querySelector('.dialog-close')?.addEventListener('click', () => dlg.close());
}
