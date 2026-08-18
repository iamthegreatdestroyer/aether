/**
 * The aircraft layer — live planes over the map, desktop only.
 *
 * Rendering choices that matter:
 *   - a drawn plane silhouette rotated by true track, because a dot cannot show heading and
 *     heading is most of what makes a traffic map readable;
 *   - colour by altitude band (ground → cruise), the convention every ADS-B map uses, so the
 *     picture is legible to anyone who has seen one before;
 *   - emergency squawks (7500/7600/7700) drawn last and in alarm red — never averaged into
 *     the altitude ramp, because that is the one aircraft you must not miss.
 *
 * Polling is viewport-scoped and paused whenever the layer is off or the window is hidden;
 * the aggregator is a volunteer network and the contract's politeness applies.
 */

import { Popup } from 'maplibre-gl';
import type { Map as MapLibreMap, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import { registerLayer } from './registry';
import { altLabel, fetchAircraft, fetchAirframePhoto, fetchRoute, isFlightAvailable } from '../data/flight';
import { haversineKm } from '../data/geo';

const ID = 'aircraft';
const POLL_MS = 15_000;
const DEBOUNCE_MS = 600;
/** Beyond this the aggregator's radius cap makes the answer partial and misleading. */
const MAX_RADIUS_NM = 250;

const EMPTY: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] };

export interface AircraftState {
  enabled: boolean;
  available: boolean;
  count: number;
  emergencies: number;
  lastFetchIso: string | null;
}

/** A top-down airliner silhouette, drawn once into a canvas for MapLibre's sprite. */
function planeIcon(size = 40): ImageData {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const s = size / 40;
  g.translate(size / 2, size / 2);
  g.beginPath();
  // nose → right wing → tail → left wing, a symmetric silhouette pointing "up" (0°)
  g.moveTo(0, -16 * s);
  g.lineTo(3 * s, -6 * s);
  g.lineTo(17 * s, 3 * s);
  g.lineTo(17 * s, 6 * s);
  g.lineTo(3 * s, 2 * s);
  g.lineTo(2.5 * s, 12 * s);
  g.lineTo(7 * s, 16 * s);
  g.lineTo(7 * s, 18 * s);
  g.lineTo(0, 15 * s);
  g.lineTo(-7 * s, 18 * s);
  g.lineTo(-7 * s, 16 * s);
  g.lineTo(-2.5 * s, 12 * s);
  g.lineTo(-3 * s, 2 * s);
  g.lineTo(-17 * s, 6 * s);
  g.lineTo(-17 * s, 3 * s);
  g.lineTo(-3 * s, -6 * s);
  g.closePath();
  g.fillStyle = '#ffffff';
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.lineWidth = 1.1 * s;
  g.stroke();
  return g.getImageData(0, 0, size, size);
}

export class AircraftLayer {
  private enabled = false;
  private loaded = false;
  private timer = 0;
  private debounce = 0;
  private count = 0;
  private emergencies = 0;
  private lastFetch: number | null = null;
  private token = 0;
  private popup: Popup | null = null;

  onChange: (() => void) | null = null;

  constructor(private map: MapLibreMap) {
    this.map.on('moveend', () => {
      if (!this.enabled) return;
      window.clearTimeout(this.debounce);
      this.debounce = window.setTimeout(() => void this.refresh(), DEBOUNCE_MS);
    });
    this.map.on('click', ID, (e) => this.openPopup(e));
    this.map.on('mouseenter', ID, () => (this.map.getCanvas().style.cursor = 'pointer'));
    this.map.on('mouseleave', ID, () => (this.map.getCanvas().style.cursor = ''));
    document.addEventListener('visibilitychange', () => {
      // Battery and courtesy: a hidden window has no reason to poll a volunteer network.
      if (document.hidden) window.clearInterval(this.timer);
      else if (this.enabled) this.timer = window.setInterval(() => void this.refresh(), POLL_MS);
    });
  }

  get state(): AircraftState {
    return {
      enabled: this.enabled,
      available: isFlightAvailable(),
      count: this.count,
      emergencies: this.emergencies,
      lastFetchIso: this.lastFetch ? new Date(this.lastFetch).toISOString() : null,
    };
  }

  async enable(): Promise<void> {
    if (this.enabled) return;
    if (!isFlightAvailable()) {
      throw new Error(
        'Live aircraft need the desktop app: every open ADS-B feed refuses browser requests.',
      );
    }
    registerLayer(ID, 'adsb-lol');

    if (!this.loaded) {
      if (!this.map.hasImage('plane')) this.map.addImage('plane', planeIcon(), { pixelRatio: 2 });
      this.map.addSource(ID, { type: 'geojson', data: EMPTY });
      this.map.addLayer({
        id: ID,
        type: 'symbol',
        source: ID,
        layout: {
          'icon-image': 'plane',
          'icon-rotate': ['get', 'track'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.35, 7, 0.6, 11, 0.85],
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 10,
          'text-offset': [0, 1.4],
          'text-optional': true,
          'text-allow-overlap': false,
        },
        paint: {
          // Altitude bands, the convention every traffic map uses; emergencies override.
          'icon-color': [
            'case',
            ['get', 'emergency'],
            '#ff3b30',
            [
              'interpolate',
              ['linear'],
              ['get', 'altBand'],
              0, '#f7c948',
              10000, '#7ee787',
              25000, '#58a6ff',
              40000, '#c9a0ff',
            ],
          ],
          'icon-halo-color': 'rgba(0,0,0,0.6)',
          'icon-halo-width': 1,
          'text-color': '#dbe2f0',
          'text-halo-color': 'rgba(0,0,0,0.85)',
          'text-halo-width': 1.2,
        },
      });
      this.loaded = true;
    } else {
      this.map.setLayoutProperty(ID, 'visibility', 'visible');
    }
    this.enabled = true;
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), POLL_MS);
    this.onChange?.();
  }

  disable(): void {
    if (!this.enabled) return;
    window.clearInterval(this.timer);
    window.clearTimeout(this.debounce);
    this.popup?.remove();
    this.popup = null;
    if (this.map.getLayer(ID)) this.map.setLayoutProperty(ID, 'visibility', 'none');
    this.enabled = false;
    this.count = 0;
    this.onChange?.();
  }

  private async refresh(): Promise<void> {
    if (!this.enabled || !this.loaded) return;
    const b = this.map.getBounds();
    const c = this.map.getCenter();
    // Radius that covers the viewport corner, in nautical miles.
    const cornerKm = haversineKm(c.lat, c.lng, b.getNorth(), b.getEast());
    const radiusNm = Math.min(MAX_RADIUS_NM, Math.max(5, cornerKm / 1.852));

    const token = ++this.token;
    try {
      const ac = await fetchAircraft(c.lat, c.lng, radiusNm);
      if (token !== this.token || !this.enabled) return; // a newer pan won
      this.count = ac.length;
      this.emergencies = ac.filter((a) => a.emergency).length;
      this.lastFetch = Date.now();
      (this.map.getSource(ID) as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: ac.map((a) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
          properties: {
            track: a.track ?? 0,
            altBand: a.altFt === 'ground' || a.altFt === null ? 0 : a.altFt,
            emergency: a.emergency,
            label: a.flight ?? a.reg ?? '',
            hex: a.hex,
            flight: a.flight ?? '',
            reg: a.reg ?? '',
            acType: a.type ?? '',
            alt: a.altFt === 'ground' ? 'ground' : (a.altFt ?? -1),
            gs: a.gs ?? -1,
            vert: a.vertFpm ?? 0,
            squawk: a.squawk ?? '',
          },
        })),
      });
      this.onChange?.();
    } catch (err) {
      console.warn('[aircraft]', err);
    }
  }

  private openPopup(e: MapLayerMouseEvent): void {
    const f = e.features?.[0];
    if (!f || f.geometry.type !== 'Point') return;
    const p = f.properties as Record<string, string | number | boolean>;
    const [lon, lat] = f.geometry.coordinates as [number, number];

    const alt = p['alt'] === 'ground' ? 'ground' : Number(p['alt']);
    const climb =
      Number(p['vert']) > 300 ? ' ↑ climbing' : Number(p['vert']) < -300 ? ' ↓ descending' : '';
    const idLine = `<b>${p['flight'] || p['reg'] || p['hex']}</b>${p['acType'] ? ` · ${p['acType']}` : ''}`;
    const base =
      `${idLine}<br>${altLabel(alt === 'ground' ? 'ground' : alt === -1 ? null : (alt as number))}` +
      `${Number(p['gs']) >= 0 ? ` · ${p['gs']} kt` : ''}${climb}` +
      `${p['reg'] ? `<br><span class="fire-popup-ray">${p['reg']}</span>` : ''}` +
      `${p['emergency'] ? `<br><b style="color:#ff3b30">EMERGENCY squawk ${p['squawk']}</b>` : ''}`;

    this.popup?.remove();
    this.popup = new Popup({ closeButton: true, maxWidth: '280px', className: 'fire-popup' })
      .setLngLat([lon, lat])
      .setHTML(`${base}<br><span class="fire-popup-ray">looking up route…</span>`)
      .addTo(this.map);

    const popup = this.popup;

    // A photo of THIS airframe, if anyone has ever shot it. Planespotters requires the
    // photographer credit and a link back, so both ship with the image.
    const reg = String(p['reg'] || '');
    if (reg) {
      void fetchAirframePhoto(reg).then((photo) => {
        if (popup !== this.popup || !photo) return;
        const img = document.createElement('div');
        img.className = 'plane-photo';
        img.innerHTML =
          `<img src="${photo.thumbUrl}" alt="${reg}" loading="lazy">` +
          `<a href="${photo.pageUrl}" target="_blank" rel="noopener">📷 ${photo.photographer} · Planespotters</a>`;
        popup.getElement()?.querySelector('.maplibregl-popup-content')?.prepend(img);
      });
    }

    const callsign = String(p['flight'] || '');
    if (!callsign) {
      popup.setHTML(base);
      return;
    }
    void fetchRoute(callsign).then((r) => {
      if (popup !== this.popup) return;
      if (!r) {
        popup.setHTML(`${base}<br><span class="fire-popup-ray">route not in the database</span>`);
        return;
      }
      const leg =
        r.originIata && r.destIata
          ? `${r.originIata} → ${r.destIata}`
          : (r.originName ?? '?') + ' → ' + (r.destName ?? '?');
      popup.setHTML(
        `${base}<br><b>${leg}</b>` +
          `${r.originName && r.destName ? `<br><span class="fire-popup-ray">${r.originName} → ${r.destName}</span>` : ''}` +
          `${r.airlineName ? `<br><span class="fire-popup-ray">${r.airlineName}</span>` : ''}`,
      );
    });
  }
}
