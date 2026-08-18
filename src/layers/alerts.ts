/**
 * Warning polygons — NWS active alerts drawn on the map.
 *
 * Severity drives colour and nothing else does: an Extreme alert must not be able to look
 * like a Minor one because of draw order or opacity accidents. Polygons are stroked as well
 * as filled, because a translucent fill over a dark basemap loses its edge exactly where the
 * edge is the information ("am I inside it?").
 */

import { Popup } from 'maplibre-gl';
import type { Map as MapLibreMap, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { registerLayer } from './registry';
import { expiryLabel, fetchAlertPolygons } from '../data/alerts';
import type { Alert } from '../data/alerts';

const FILL = 'alerts-fill';
const LINE = 'alerts-line';
const SRC = 'alerts';
const REFRESH_MS = 5 * 60 * 1000;

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

export interface AlertLayerState {
  enabled: boolean;
  polygons: number;
  extreme: number;
  severe: number;
}

export class AlertsLayer {
  private enabled = false;
  private loaded = false;
  private timer = 0;
  private counts = { polygons: 0, extreme: 0, severe: 0 };
  private popup: Popup | null = null;

  onChange: (() => void) | null = null;

  constructor(private map: MapLibreMap) {
    this.map.on('click', FILL, (e) => this.openPopup(e));
    this.map.on('mouseenter', FILL, () => (this.map.getCanvas().style.cursor = 'pointer'));
    this.map.on('mouseleave', FILL, () => (this.map.getCanvas().style.cursor = ''));
  }

  get state(): AlertLayerState {
    return { enabled: this.enabled, ...this.counts };
  }

  async enable(): Promise<void> {
    if (this.enabled) return;
    registerLayer(SRC, 'nws-alerts');

    if (!this.loaded) {
      this.map.addSource(SRC, { type: 'geojson', data: EMPTY });
      const before = this.map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
      const colour = [
        'match',
        ['get', 'severity'],
        'Extreme', '#e0245e',
        'Severe', '#ff6b35',
        'Moderate', '#f7c948',
        '#8899aa',
      ] as unknown as string;
      this.map.addLayer(
        {
          id: FILL,
          type: 'fill',
          source: SRC,
          paint: { 'fill-color': colour, 'fill-opacity': 0.18 },
        },
        before,
      );
      this.map.addLayer(
        {
          id: LINE,
          type: 'line',
          source: SRC,
          paint: { 'line-color': colour, 'line-width': 1.6, 'line-opacity': 0.9 },
        },
        before,
      );
      this.loaded = true;
    } else {
      this.map.setLayoutProperty(FILL, 'visibility', 'visible');
      this.map.setLayoutProperty(LINE, 'visibility', 'visible');
    }
    this.enabled = true;
    await this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), REFRESH_MS);
    this.onChange?.();
  }

  disable(): void {
    if (!this.enabled) return;
    window.clearInterval(this.timer);
    this.popup?.remove();
    this.popup = null;
    for (const id of [FILL, LINE]) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', 'none');
    }
    this.enabled = false;
    this.onChange?.();
  }

  private async refresh(): Promise<void> {
    if (!this.enabled) return;
    try {
      const alerts = await fetchAlertPolygons();
      this.counts = {
        polygons: alerts.length,
        extreme: alerts.filter((a) => a.severity === 'Extreme').length,
        severe: alerts.filter((a) => a.severity === 'Severe').length,
      };
      (this.map.getSource(SRC) as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: alerts.map((a) => ({
          type: 'Feature',
          geometry: a.geometry!,
          properties: {
            severity: a.severity,
            event: a.event,
            headline: a.headline ?? '',
            expires: expiryLabel(a),
            sender: a.senderName ?? '',
            instruction: (a.instruction ?? '').slice(0, 220),
          },
        })),
      });
      this.onChange?.();
    } catch (err) {
      console.warn('[alerts]', err);
    }
  }

  private openPopup(e: MapLayerMouseEvent): void {
    const f = e.features?.[0];
    if (!f) return;
    const p = f.properties as Record<string, string>;
    this.popup?.remove();
    this.popup = new Popup({ closeButton: true, maxWidth: '320px', className: 'fire-popup' })
      .setLngLat(e.lngLat)
      .setHTML(
        `<b>${p['event']}</b> · ${p['severity']}<br>` +
          `<span class="fire-popup-ray">${p['expires']}${p['sender'] ? ` · ${p['sender']}` : ''}</span>` +
          `${p['instruction'] ? `<br><br>${p['instruction']}…` : ''}`,
      )
      .addTo(this.map);
  }
}

export type { Alert };
