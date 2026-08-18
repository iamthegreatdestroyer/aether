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

import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import { registerLayer } from './registry';
import { fetchLiveFiresBbox, getFirmsKey } from '../data/smoke';
import type { LiveCluster } from '../data/smoke';

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

  onChange: (() => void) | null = null;

  constructor(private map: MapLibreMap) {
    this.map.on('moveend', () => {
      if (!this.enabled) return;
      window.clearTimeout(this.debounce);
      this.debounce = window.setTimeout(() => void this.refreshLive(), DEBOUNCE_MS);
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
