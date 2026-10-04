/**
 * Edit a tile: its name, and (new) the place it points at - search for any ZIP, town or address
 * and the tile moves there, keeping its slot in the rail. Previously the only ways to change a
 * tile's place were delete-and-re-add, which also lost its position and Home's special pin.
 */

import { createPlaceSearch } from './placeSearch';
import type { SavedLocation } from './locations';

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function buildEditDialog(): HTMLDialogElement {
  const dlg = document.createElement('dialog');
  dlg.className = 'sources-dialog edit-dialog';
  document.body.append(dlg);
  return dlg;
}

export function openEditLocation(
  dlg: HTMLDialogElement,
  loc: SavedLocation,
  onSave: (name: string, place: { lat: number; lon: number } | null) => void,
): void {
  let place: { lat: number; lon: number; label: string } | null = null;

  const paint = () => {
    dlg.innerHTML = `<button class="dialog-close" aria-label="Close">×</button>
      <h2>Edit ${esc(loc.name)}</h2>
      <label class="edit-row">Name
        <input class="edit-name" type="text" value="${esc(loc.name)}" maxlength="60"></label>
      <p class="edit-place">${
        place
          ? `<b>Moving to:</b> ${esc(place.label)}`
          : `<b>Place:</b> ${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}`
      }</p>
      <div class="edit-search"></div>
      <p class="sources-intro">${
        place
          ? 'A tile pointed at a new place starts a fresh forecast track record there. The old place&#39;s history stays stored, it just stops growing.'
          : 'Search below to point this tile somewhere else - it keeps its slot in the list.'
      }</p>
      <div class="search-actions">
        <button class="edit-save">Save</button>
        <button class="edit-cancel">Cancel</button>
      </div>`;
    dlg.querySelector('.dialog-close')!.addEventListener('click', () => dlg.close());
    dlg.querySelector('.edit-cancel')!.addEventListener('click', () => dlg.close());
    dlg.querySelector('.edit-search')!.append(
      createPlaceSearch({
        placeholder: 'Move to: ZIP, town or address',
        onPick: (hit) => {
          const typed = dlg.querySelector<HTMLInputElement>('.edit-name')?.value;
          place = { lat: hit.lat, lon: hit.lon, label: hit.label };
          paint();
          // Offer the found place's name unless the person already typed their own.
          const nameBox = dlg.querySelector<HTMLInputElement>('.edit-name')!;
          nameBox.value = typed && typed !== loc.name ? typed : loc.id === 'home' ? loc.name : hit.name;
        },
      }),
    );
    dlg.querySelector('.edit-save')!.addEventListener('click', () => {
      const name = dlg.querySelector<HTMLInputElement>('.edit-name')!.value.trim();
      dlg.close();
      onSave(name || loc.name, place ? { lat: place.lat, lon: place.lon } : null);
    });
  };

  paint();
  dlg.showModal();
}
