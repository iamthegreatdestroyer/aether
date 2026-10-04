/**
 * A reusable "find a place" box: type a ZIP, town or address, press Search, pick a result.
 *
 * Searches only on an explicit submit (Enter or the button), never as-you-type — the geocoder
 * is a volunteer service whose policy forbids auto-complete. Results always show their long
 * label, because the same string names many places and the user, not this code, decides which
 * one they meant.
 */

import { PlaceSearchError, searchPlaces } from '../data/places';
import type { PlaceHit } from '../data/places';

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function createPlaceSearch(opts: {
  placeholder?: string;
  onPick: (hit: PlaceHit) => void;
}): HTMLElement {
  const root = document.createElement('div');
  root.className = 'place-search';
  root.innerHTML = `
    <form class="place-search-form">
      <input type="search" class="place-search-input" autocomplete="off" spellcheck="false"
        placeholder="${esc(opts.placeholder ?? 'ZIP, town or street address')}" aria-label="Search for a place">
      <button type="submit" class="place-search-go">Search</button>
    </form>
    <div class="place-search-status muted" role="status"></div>
    <ul class="place-search-results"></ul>`;

  const form = root.querySelector('form')!;
  const input = root.querySelector('input')!;
  const go = root.querySelector('button')!;
  const status = root.querySelector('.place-search-status')!;
  const list = root.querySelector('ul')!;
  let seq = 0;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const mine = ++seq;
    list.innerHTML = '';
    status.textContent = 'Searching OpenStreetMap…';
    go.disabled = true;
    searchPlaces(input.value)
      .then((hits) => {
        if (mine !== seq) return;
        if (hits.length === 0) {
          status.textContent = 'Nothing found. Try adding the state or country, or a nearby town.';
          return;
        }
        status.textContent = hits.length === 1 ? '1 match' : `${hits.length} matches — pick the one you meant`;
        for (const hit of hits) {
          const li = document.createElement('li');
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'place-search-hit';
          b.innerHTML = `<b>${esc(hit.name)}</b><span class="muted">${esc(hit.label)}</span>`;
          b.addEventListener('click', () => opts.onPick(hit));
          li.append(b);
          list.append(li);
        }
      })
      .catch((err) => {
        if (mine !== seq) return;
        status.textContent =
          err instanceof PlaceSearchError
            ? err.message
            : 'The place search did not answer (OpenStreetMap may be busy) — try again in a moment.';
      })
      .finally(() => {
        if (mine === seq) go.disabled = false;
      });
  });

  return root;
}
