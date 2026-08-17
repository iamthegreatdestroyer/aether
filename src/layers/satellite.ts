/**
 * Satellite layer — NASA GIBS WMTS, daily VIIRS true color.
 *
 * One deliberately-chosen global layer for P2 rather than a catalog: VIIRS SNPP Corrected
 * Reflectance is global, reliable, and daily. Yesterday's date is requested on purpose —
 * GIBS near-real-time imagery lags ~3 h and today's granules are incomplete until late in
 * the UTC day; a partially-empty "today" reads as a broken layer, while a complete
 * "yesterday" reads as a satellite picture. The date is displayed so the age is honest.
 * Geostationary sub-hourly layers (GOES GeoColor etc.) are the P4-era upgrade.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { source } from '../data/sources.mjs';
import { registerLayer } from './registry';

const LAYER = 'VIIRS_SNPP_CorrectedReflectance_TrueColor';
const MATRIX = 'GoogleMapsCompatible_Level9';
const ID = 'satellite';

function yesterdayUtc(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export class SatelliteLayer {
  private enabled = false;
  date: string | null = null;

  constructor(private map: MapLibreMap) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  enable(): void {
    if (this.enabled) return;
    const s = source('nasa-gibs');
    if (!s.baseUrl) throw new Error('nasa-gibs contract entry has no baseUrl');
    registerLayer(ID, 'nasa-gibs');
    this.date = yesterdayUtc();

    // WMTS REST tile pattern. GIBS serves KVP and REST; REST maps directly onto MapLibre's
    // raster source. {y}/{x} order per WMTS TileMatrix conventions.
    const tiles = `${s.baseUrl}/${LAYER}/default/${this.date}/${MATRIX}/{z}/{y}/{x}.jpg`;

    // Under the radar frames and the labels: insert before the first radar layer if radar is
    // on, else before the first symbol layer.
    const layers = this.map.getStyle().layers;
    const before =
      layers.find((l) => l.id.startsWith('radar-frame-'))?.id ??
      layers.find((l) => l.type === 'symbol')?.id;

    this.map.addSource(ID, {
      type: 'raster',
      tiles: [tiles],
      tileSize: 256,
      maxzoom: 9,
      attribution: s.attribution ?? 'NASA GIBS/Worldview',
    });
    this.map.addLayer(
      { id: ID, type: 'raster', source: ID, paint: { 'raster-opacity': 0.85 } },
      before,
    );
    this.enabled = true;
  }

  disable(): void {
    if (!this.enabled) return;
    if (this.map.getLayer(ID)) this.map.removeLayer(ID);
    if (this.map.getSource(ID)) this.map.removeSource(ID);
    this.enabled = false;
    this.date = null;
  }
}
