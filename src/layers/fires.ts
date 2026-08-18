/**
 * FIRMS fire clusters on the map — dots sized by detection count, coloured by summed FRP.
 *
 * Same shape as the divergence layer: one same-origin artifact from the Tier B cron, loaded
 * on first enable, never at boot. The GeoJSON's foreign members (builtAt, detections) are
 * ignored by MapLibre and read by the smoke panel.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { registerLayer } from './registry';

const ID = 'fires';

export class FiresLayer {
  private enabled = false;
  private loaded = false;

  onChange: (() => void) | null = null;

  constructor(private map: MapLibreMap) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  async enable(): Promise<void> {
    if (this.enabled) return;
    registerLayer(ID, 'firms');

    if (!this.loaded) {
      this.map.addSource(ID, { type: 'geojson', data: 'data/fires/latest.json' });
      const before = this.map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
      this.map.addLayer(
        {
          id: ID,
          type: 'circle',
          source: ID,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['get', 'n'], 1, 2, 30, 5, 300, 9],
            'circle-color': [
              'interpolate',
              ['linear'],
              ['get', 'frp'],
              0, '#ff9a3c',
              50, '#ff5c33',
              500, '#e01e1e',
            ],
            'circle-opacity': 0.75,
            'circle-stroke-width': 0,
          },
        },
        before,
      );
      this.loaded = true;
    } else {
      this.map.setLayoutProperty(ID, 'visibility', 'visible');
    }
    this.enabled = true;
    this.onChange?.();
  }

  disable(): void {
    if (!this.enabled) return;
    if (this.map.getLayer(ID)) this.map.setLayoutProperty(ID, 'visibility', 'none');
    this.enabled = false;
    this.onChange?.();
  }
}
