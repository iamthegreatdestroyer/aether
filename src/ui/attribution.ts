/**
 * The Data Sources screen and footer line — a P0 deliverable, not P6 polish.
 *
 * Attribution obligations survive the personal-use carve-out (CC BY attaches to *display of
 * the data*), and §5.3.2 of the proposal frames the screen as part of the product identity:
 * provenance is the trust story. Everything here renders from the contract in `sources.mjs`,
 * so a source cannot be added without its obligation appearing — same mechanism as the
 * generated ATTRIBUTION.md.
 */

import { SOURCES, requiredAttributions, source } from '../data/sources.mjs';

/** The always-visible line: the one legally-live attribution P0 displays data from. */
export function renderFooter(el: HTMLElement, onOpenSources: () => void): void {
  const om = source('open-meteo');
  const link = document.createElement('a');
  link.href = om.attributionUrl ?? '#';
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = om.attribution ?? om.name;

  const btn = document.createElement('button');
  btn.className = 'footer-sources';
  btn.textContent = 'Data sources';
  btn.addEventListener('click', onOpenSources);

  el.append(link, ' · ', btn);
}

export function buildSourcesDialog(): HTMLDialogElement {
  const dlg = document.createElement('dialog');
  dlg.className = 'sources-dialog';

  const close = document.createElement('button');
  close.className = 'dialog-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => dlg.close());

  const h = document.createElement('h2');
  h.textContent = 'Data sources';

  const intro = document.createElement('p');
  intro.className = 'sources-intro';
  intro.textContent =
    'Every feed this app uses, with its licence. Attribution is displayed because it is ' +
    'legally required even for personal use — and because provenance is the point.';

  const required = document.createElement('ul');
  required.className = 'sources-list';
  for (const a of requiredAttributions()) {
    const li = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = a.text;
    li.append(name, ` — ${a.license}`);
    if (a.url) {
      const link = document.createElement('a');
      link.href = a.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = ' ↗';
      li.append(link);
    }
    required.append(li);
  }

  const pdHead = document.createElement('h3');
  pdHead.textContent = 'No attribution legally required — listed as provenance';
  const pd = document.createElement('ul');
  pd.className = 'sources-list sources-pd';
  for (const s of SOURCES.filter((x) => !x.attribution)) {
    const li = document.createElement('li');
    li.textContent = `${s.name} — ${s.license}`;
    pd.append(li);
  }

  dlg.append(close, h, intro, required, pdHead, pd);
  document.body.append(dlg);
  return dlg;
}
