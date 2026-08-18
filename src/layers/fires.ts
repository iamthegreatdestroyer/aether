/**
 * FIRMS fire dots — live where you're looking, snapshot where you're not.
 *
 * Two planes, one toggle:
 *   cron   the global 0.25° cluster GeoJSON from the Tier B cron — always available,
 *          shown at world scale and whenever there is no MAP_KEY.
 *   live   viewport-scoped keyed queries (same lane as the Smoke panel, ~20 min after
 *          overpass): when the view is zoomed to a queryable span, the live result
 *          REPLACES the cron dots for that view — white-stroked so fresh reads as fresh.
 *
 * The honesty rule is the switch itself: a world-spanning live query would be a multi-MB
 * CSV and a quota bonfire, so live mode engages only below MAX_LIVE_SPAN. Zooming out
 * returns to the snapshot, which is what it says it is.
 */

import { Popup } from 'maplibre-gl';
import type { Map as MapLibreMap, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import { registerLayer } from './registry';
import { compass, fetchLiveFiresBbox, fireRayTest, getFirmsKey } from '../data/smoke';
import type { LiveCluster } from '../data/smoke';
import { haversineKm } from '../data/geo';

const ID = 'fires';
const LIVE_ID = 'fires-live';

/** Max viewport span (lon° × lat°) still worth a live query — ~continental scale. */
const MAX_LIVE_SPAN_SQDEG = 40 * 25;
/** Don't requery an unchanged-ish viewport more often than this. */
const REQUERY_MS = 120_000;
const DEBOUNCE_MS = 700;

const EMPTY: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] };

export interface FiresState {
  enabled: boolean;
  mode: 'live' | 'cron' | 'off';
  liveClusters: number;
  newestDetectionIso: string | null;
}

export class FiresLayer {
  private enabled = false;
  private loaded = false;
  private debounce = 0;
  private lastQuery = { west: 0, south: 0, east: 0, north: 0, at: 0 };
  private liveActive = false;
  private liveCount = 0;
  private newestMs = 0;
  private queryToken = 0;
  private popup: Popup | null = null;

  onChange: (() => void) | null = null;
  /** Set by main.ts — the popup's ray test runs against the nearest saved location. */
  locationsProvider: (() => Array<{ name: string; lat: number; lon: number }>) | null = null;

  constructor(private map: MapLibreMap) {
    this.map.on('moveend', () => {
      if (!this.enabled) return;
      window.clearTimeout(this.debounce);
      this.debounce = window.setTimeout(() => void this.refreshLive(), DEBOUNCE_MS);
    });
    for (const layer of [ID, LIVE_ID]) {
      this.map.on('click', layer, (e) => this.openPopup(e));
      this.map.on('mouseenter', layer, () => (this.map.getCanvas().style.cursor = 'pointer'));
      this.map.on('mouseleave', layer, () => (this.map.getCanvas().style.cursor = ''));
    }
  }

  /**
   * The per-fire receipt: intensity + detection age (live dots carry acqMs; snapshot dots
   * say what they are instead), then the SAME ray test the Smoke panel runs, against the
   * nearest saved location — filled in asynchronously once the wind grid is sampled.
   */
  private openPopup(e: MapLayerMouseEvent): void {
    const f = e.features?.[0];
    if (!f || f.geometry.type !== 'Point') return;
    const [lon, lat] = f.geometry.coordinates as [number, number];
    this.openDotAt(lon, lat, f.properties as { n: number; frp: number; acqMs?: number });
  }

  /** The clusters behind the live source — kept for openDotAt and future panel→map jumps. */
  private liveClusters: LiveCluster[] = [];

  /**
   * Open the receipt popup for the dot nearest (lng, lat) — public so callers that know a
   * fire's coordinates (debug hook, future panel rows) can drive the same path the map
   * click uses. Falls back to explicit props when provided.
   */
  openDotAt(lon: number, lat: number, props?: { n: number; frp: number; acqMs?: number }): void {
    let p = props ?? null;
    if (!p && this.liveClusters.length > 0) {
      const c = this.liveClusters.reduce((a, b) =>
        haversineKm(lat, lon, a.lat, a.lon) <= haversineKm(lat, lon, b.lat, b.lon) ? a : b,
      );
      lon = c.lon;
      lat = c.lat;
      p = { n: c.n, frp: c.frp, acqMs: c.acqMs };
    }
    if (!p) return;

    const seen = p.acqMs
      ? `seen ${new Date(p.acqMs).toISOString().slice(11, 16)}Z (${Math.max(0, Math.round((Date.now() - p.acqMs) / 60_000))} min ago)`
      : 'cron snapshot (up to 24 h window)';
    const frp = Number(p.frp);
    const base = `<b>${frp < 10 ? frp.toFixed(1) : frp.toFixed(0)} MW</b> · ${p.n} detection${p.n > 1 ? 's' : ''}<br>${seen}`;

    this.popup?.remove();
    this.popup = new Popup({ closeButton: true, maxWidth: '280px', className: 'fire-popup' })
      .setLngLat([lon, lat])
      .setHTML(`${base}<br><span class="fire-popup-ray">running ray test…</span>`)
      .addTo(this.map);

    const locs = this.locationsProvider?.() ?? [];
    if (locs.length === 0) {
      this.popup.setHTML(base);
      return;
    }
    const nearest = locs.reduce((a, b) =>
      haversineKm(lat, lon, a.lat, a.lon) <= haversineKm(lat, lon, b.lat, b.lon) ? a : b,
    );
    const popup = this.popup;
    void fireRayTest({ lat, lon, frp: Number(p.frp), n: p.n, acqMs: p.acqMs }, nearest)
      .then((t) => {
        if (popup !== this.popup) return; // another dot was clicked meanwhile
        const word = { toward: '→ toward', glancing: '↝ glancing at', away: '↛ away from' }[t.verdict];
        const cls = { toward: 'smoke-toward', glancing: 'smoke-glancing', away: 'smoke-away' }[t.verdict];
        popup.setHTML(
          `${base}<br>` +
            `${t.distanceKm} km ${compass(t.bearingFromYou)} of ${nearest.name}<br>` +
            `<span class="${cls}">${word} ${nearest.name}</span> — wind at fire ${t.windAtFireMs} m/s, ${t.offAxisDeg}° off-axis`,
        );
      })
      .catch(() => {
        if (popup === this.popup) popup.setHTML(base);
      });
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get state(): FiresState {
    return {
      enabled: this.enabled,
      mode: !this.enabled ? 'off' : this.liveActive ? 'live' : 'cron',
      liveClusters: this.liveCount,
      newestDetectionIso: this.newestMs > 0 ? new Date(this.newestMs).toISOString() : null,
    };
  }

  async enable(): Promise<void> {
    if (this.enabled) return;
    registerLayer(ID, 'firms');

    if (!this.loaded) {
      this.map.addSource(ID, { type: 'geojson', data: 'data/fires/latest.json' });
      this.map.addSource(LIVE_ID, { type: 'geojson', data: EMPTY });
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
      // Live dots: same FRP ramp, white-stroked — "fresh" must be visually distinct.
      this.map.addLayer(
        {
          id: LIVE_ID,
          type: 'circle',
          source: LIVE_ID,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['get', 'n'], 1, 2.5, 30, 6, 300, 10],
            'circle-color': [
              'interpolate',
              ['linear'],
              ['get', 'frp'],
              0, '#ffb35c',
              50, '#ff5c33',
              500, '#e01e1e',
            ],
            'circle-opacity': 0.9,
            'circle-stroke-width': 1,
            'circle-stroke-color': '#ffffff',
          },
        },
        before,
      );
      this.loaded = true;
    } else {
      this.map.setLayoutProperty(ID, 'visibility', 'visible');
      this.map.setLayoutProperty(LIVE_ID, 'visibility', 'visible');
    }
    this.enabled = true;
    void this.refreshLive();
    this.onChange?.();
  }

  disable(): void {
    if (!this.enabled) return;
    this.popup?.remove();
    this.popup = null;
    window.clearTimeout(this.debounce);
    if (this.map.getLayer(ID)) this.map.setLayoutProperty(ID, 'visibility', 'none');
    if (this.map.getLayer(LIVE_ID)) this.map.setLayoutProperty(LIVE_ID, 'visibility', 'none');
    this.enabled = false;
    this.onChange?.();
  }

  /** Decide live-vs-cron for the current viewport and populate accordingly. */
  private async refreshLive(): Promise<void> {
    if (!this.enabled || !this.loaded) return;
    const b = this.map.getBounds();
    const west = b.getWest();
    const south = b.getSouth();
    const east = b.getEast();
    const north = b.getNorth();
    const span = Math.abs(east - west) * Math.abs(north - south);

    const key = getFirmsKey();
    if (!key || span > MAX_LIVE_SPAN_SQDEG || Math.abs(east - west) >= 360) {
      this.setCronMode();
      return;
    }

    // Skip if this viewport is inside the last-queried box and the data is fresh.
    const lq = this.lastQuery;
    const inside =
      west >= lq.west && east <= lq.east && south >= lq.south && north <= lq.north;
    if (this.liveActive && inside && Date.now() - lq.at < REQUERY_MS) return;

    // Query a padded box so small pans stay inside it.
    const padLon = Math.abs(east - west) * 0.25;
    const padLat = Math.abs(north - south) * 0.25;
    const q = {
      west: west - padLon,
      south: south - padLat,
      east: east + padLon,
      north: north + padLat,
      at: Date.now(),
    };
    const token = ++this.queryToken;
    try {
      const live = await fetchLiveFiresBbox(q.west, q.south, q.east, q.north);
      if (token !== this.queryToken || !this.enabled) return; // superseded by a newer pan
      if (!live) {
        this.setCronMode();
        return;
      }
      this.lastQuery = q;
      this.liveActive = true;
      this.liveClusters = live.clusters;
      this.liveCount = live.clusters.length;
      this.newestMs = live.newestMs;
      (this.map.getSource(LIVE_ID) as GeoJSONSource).setData(toGeoJson(live.clusters));
      // Live replaces the snapshot for the covered view — two ages of dot at once would lie.
      this.map.setLayoutProperty(ID, 'visibility', 'none');
      this.onChange?.();
    } catch {
      // Live failed (quota, network): the snapshot is still the truth we have.
      if (token === this.queryToken) this.setCronMode();
    }
  }

  private setCronMode(): void {
    if (!this.loaded) return;
    this.liveActive = false;
    this.liveClusters = [];
    this.liveCount = 0;
    (this.map.getSource(LIVE_ID) as GeoJSONSource).setData(EMPTY);
    if (this.enabled) this.map.setLayoutProperty(ID, 'visibility', 'visible');
    this.onChange?.();
  }
}

function toGeoJson(clusters: LiveCluster[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: clusters.map((c) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
      properties: { n: c.n, frp: c.frp, acqMs: c.acqMs },
    })),
  };
}
