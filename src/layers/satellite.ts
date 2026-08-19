/**
 * Satellite layer — NASA GIBS WMTS, daily VIIRS true color.
 *
 * One deliberately-chosen global layer for P2 rather than a catalog: VIIRS SNPP Corrected
 * Reflectance is global, reliable, and daily. The date is displayed so the age is honest.
 * Geostationary sub-hourly layers (GOES GeoColor etc.) are the P4-era upgrade.
 *
 * WHY THE DATE IS PROBED RATHER THAN ASSUMED (owner screenshot, 2026-08-19):
 * "yesterday UTC" was hard-coded on the reasoning that today is always incomplete. True —
 * but yesterday is not always complete either. VIIRS images the Americas late in the UTC
 * day (~17–23 UTC) and near-real-time processing lags a few hours, so for several hours
 * after UTC midnight the previous day's western hemisphere is still filling in. That is
 * exactly when someone in Florida is looking at the map, and it renders as a black wedge
 * across North America.
 *
 * Measured at 00:18 UTC: the same tile was 9 KB for yesterday and 21 KB for the day before
 * — a mostly-black JPEG versus a real picture. So the layer now PROBES a tile over the
 * Americas and steps back a day if it comes back mostly black. Two candidate days, then it
 * gives up and shows what it has rather than an empty map.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { source } from '../data/sources.mjs';
import { registerLayer } from './registry';

const LAYER = 'VIIRS_SNPP_CorrectedReflectance_TrueColor';
const MATRIX = 'GoogleMapsCompatible_Level9';
const ID = 'satellite';

function utcDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Fraction of a tile that is pure black — i.e. granules that have not landed yet. Real
 * imagery is never 0,0,0 even over night ocean in a true-colour composite; missing data is.
 */
async function blackFraction(url: string): Promise<number> {
  const img = new Image();
  img.crossOrigin = 'anonymous'; // GIBS sends Access-Control-Allow-Origin: * (measured)
  const loaded = new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
  });
  img.src = url;
  if (!(await loaded)) return 1; // a tile that will not load is as good as missing

  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64; // downsampling is fine: we are measuring coverage, not detail
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  ctx.drawImage(img, 0, 0, 64, 64);
  let black = 0;
  const { data } = ctx.getImageData(0, 0, 64, 64);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i]! < 8 && data[i + 1]! < 8 && data[i + 2]! < 8) black++;
  }
  return black / (data.length / 4);
}

/**
 * The most recent day whose imagery actually covers the Americas. The probe tile (z3, the
 * one spanning North America and the eastern Pacific) is the one that empties first, because
 * those granules are acquired last in the UTC day.
 */
async function pickCoveredDate(baseUrl: string): Promise<{ date: string; steppedBack: boolean }> {
  for (let back = 1; back <= 2; back++) {
    const date = utcDaysAgo(back);
    const probe = `${baseUrl}/${LAYER}/default/${date}/${MATRIX}/3/3/1.jpg`;
    const black = await blackFraction(probe);
    if (black < 0.35) return { date, steppedBack: back > 1 };
  }
  // Both candidates look empty: show the older one rather than nothing, and say so.
  return { date: utcDaysAgo(2), steppedBack: true };
}

export class SatelliteLayer {
  private enabled = false;
  date: string | null = null;

  constructor(private map: MapLibreMap) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** True when the freshest day was skipped because its granules had not landed. */
  steppedBack = false;

  async enable(): Promise<void> {
    if (this.enabled) return;
    const s = source('nasa-gibs');
    if (!s.baseUrl) throw new Error('nasa-gibs contract entry has no baseUrl');
    registerLayer(ID, 'nasa-gibs');
    const picked = await pickCoveredDate(s.baseUrl);
    this.date = picked.date;
    this.steppedBack = picked.steppedBack;

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
