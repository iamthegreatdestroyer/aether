/**
 * Basemap legibility pass — applied over the OpenFreeMap dark style at `style.load`.
 *
 * Why this exists (owner screenshot, 2026-08-18: "can you see any countries, states,
 * anything..?"): the vendor dark style is tuned for a map with NOTHING on top of it. Ours
 * carries a particle field, radar, satellite and fire dots, so its structural cues need MORE
 * contrast than the vendor default, not less. Measured from the live style:
 *
 *   land (background)   rgb(12,12,12)     near-black
 *   water               rgb(27,27,29)     15 values from land — continents unreadable
 *   country boundaries  hsl(0,0%,23%)     invisible under any overlay
 *   state boundaries    hsl(0,0%,21%)
 *   place labels        rgb(101,101,101)  40% grey, no halo strength
 *
 * The changes below keep the style dark (the P1 finding stands: particles at ~7% pixel
 * coverage vanish on a light basemap) but restore the three cues a weather map cannot do
 * without: where the land is, where the borders are, and what the places are called.
 *
 * Written as data + one loop rather than a forked style JSON: OpenFreeMap ships style
 * updates, and a fork would silently freeze them.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';

interface Tweak {
  layer: string;
  prop: string;
  value: unknown;
}

const TWEAKS: Tweak[] = [
  // --- land vs sea: the single most important cue at world zoom.
  { layer: 'background', prop: 'background-color', value: 'rgb(26,28,32)' },
  { layer: 'water', prop: 'fill-color', value: 'rgb(9,13,24)' },
  { layer: 'waterway', prop: 'line-color', value: 'rgb(9,13,24)' },

  // --- borders: cool and clearly brighter than the land they divide.
  { layer: 'boundary_country_z0-4', prop: 'line-color', value: 'hsl(205,22%,52%)' },
  { layer: 'boundary_country_z5-', prop: 'line-color', value: 'hsl(205,22%,52%)' },
  { layer: 'boundary_state', prop: 'line-color', value: 'hsl(205,12%,38%)' },

  // --- labels: brighter text AND a stronger halo, because they compete with the overlay.
  ...[
    'place_country_major',
    'place_country_minor',
    'place_country_other',
    'place_state',
    'place_city_large',
    'place_city',
    'place_town',
  ].flatMap((layer) => [
    { layer, prop: 'text-color', value: 'rgb(196,205,220)' },
    { layer, prop: 'text-halo-color', value: 'rgba(0,0,0,0.9)' },
    { layer, prop: 'text-halo-width', value: 1.6 },
  ]),
  { layer: 'water_name', prop: 'text-color', value: 'rgb(120,140,170)' },
  { layer: 'water_name', prop: 'text-halo-color', value: 'rgba(0,0,0,0.9)' },
];

/**
 * Apply the pass. Safe to call on every `style.load` — a missing layer is skipped rather
 * than thrown, because the vendor may rename layers and a restyle must never break the map.
 */
export function applyBasemapLegibility(map: MapLibreMap): { applied: number; missing: string[] } {
  const missing: string[] = [];
  let applied = 0;
  for (const t of TWEAKS) {
    if (!map.getLayer(t.layer)) {
      if (!missing.includes(t.layer)) missing.push(t.layer);
      continue;
    }
    try {
      map.setPaintProperty(t.layer, t.prop, t.value);
      applied++;
    } catch {
      if (!missing.includes(t.layer)) missing.push(t.layer);
    }
  }
  if (missing.length > 0) {
    console.warn('[basemap] legibility pass skipped renamed/absent layers:', missing.join(', '));
  }
  return { applied, missing };
}
