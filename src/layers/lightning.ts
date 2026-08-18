/**
 * Live lightning — GLM flashes from GOES-East + GOES-West, parsed IN THE BROWSER.
 *
 * The only truly live layer in the app: 20-second granules land on AWS open data ~15 s
 * after observation, the S3 buckets send `Access-Control-Allow-Origin: *` (measured
 * 2026-08-18 — the assumption that this needed a Tier B cron was wrong), and h5wasm reads
 * the netCDF4/HDF5 granules client-side. A 6-hourly cron was rejected for this layer on
 * honesty grounds: stale lightning is theater. This is the real thing, and its cost is the
 * app's first binary-parsing dependency: a 4.8 MB lazy chunk (wasm inlined by the
 * bundler; ~1.0 MB gzipped over the wire), fetched only on first toggle, then cached.
 *
 * Display: a rolling 5-minute window, dots fading with age, sized by flash energy
 * (femtojoules→picojoules, log scale). Coverage is the GLM fields of view — the Americas
 * and adjacent oceans; Europe/Asia have no open equivalent and the button title says so.
 *
 * Verified against a live granule before this file was written (spike/glm_h5_test.mjs):
 * flash_lat/lon are plain float32, flash_energy is int16 with array-wrapped scale/offset
 * attrs, flash_quality_flag 0 = good (all others dropped).
 */

import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import { registerLayer } from './registry';

const ID = 'lightning';
const WINDOW_MS = 5 * 60 * 1000;
const POLL_MS = 20_000;

const SATS = [
  { id: 'G19', bucket: 'https://noaa-goes19.s3.amazonaws.com', label: 'GOES-East' },
  { id: 'G18', bucket: 'https://noaa-goes18.s3.amazonaws.com', label: 'GOES-West' },
] as const;

interface Flash {
  lon: number;
  lat: number;
  /** log10 of flash energy in J — the style's size input. */
  mag: number;
  /** Observation time (granule start), epoch ms. */
  t: number;
}

/** `s20262300659400` → epoch ms (YYYY DDD HH MM SS.s). */
function keyStartMs(key: string): number | null {
  const m = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{3})_/.exec(key);
  if (!m) return null;
  const [, y, ddd, hh, mm, sss] = m;
  return (
    Date.UTC(Number(y), 0, 1, Number(hh), Number(mm), Number(sss) / 10) +
    (Number(ddd) - 1) * 86_400_000
  );
}

function hourPrefix(d: Date): string {
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const doy = Math.floor((d.getTime() - start) / 86_400_000) + 1;
  return `GLM-L2-LCFA/${y}/${String(doy).padStart(3, '0')}/${String(d.getUTCHours()).padStart(2, '0')}/`;
}

async function latestKey(bucket: string): Promise<string | null> {
  // Top of the hour: the current prefix may be empty for up to ~a minute — walk back one.
  for (const back of [0, 1]) {
    const d = new Date(Date.now() - back * 3_600_000);
    const url = `${bucket}/?list-type=2&prefix=${hourPrefix(d)}&max-keys=1000`;
    const r = await fetch(url);
    if (!r.ok) continue;
    const keys = [...(await r.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!);
    if (keys.length > 0) return keys[keys.length - 1]!;
  }
  return null;
}

type H5 = (typeof import('h5wasm'))['default'];
type Dataset = import('h5wasm').Dataset;
let h5: H5 | null = null;
let h5fs: { writeFile(n: string, d: Uint8Array): void; unlink(n: string): void } | null = null;

async function parseGranule(buf: ArrayBuffer, startMs: number): Promise<Flash[]> {
  if (!h5 || !h5fs) {
    const mod = await import('h5wasm');
    h5 = mod.default;
    h5fs = (await h5.ready).FS as typeof h5fs;
  }
  const name = `glm-${startMs}.nc`;
  h5fs!.writeFile(name, new Uint8Array(buf));
  const flashes: Flash[] = [];
  try {
    const f = new h5.File(name, 'r');
    try {
      const ds = (n: string) => f.get(n) as Dataset | null;
      const lat = ds('flash_lat')?.value as Float32Array;
      const lon = ds('flash_lon')?.value as Float32Array;
      const qc = ds('flash_quality_flag')?.value as Int16Array;
      const eD = ds('flash_energy');
      if (!lat || !lon || !eD) return [];
      const raw = eD.value as Int16Array;
      const sf = Number((eD.attrs['scale_factor']?.value as number[] | undefined)?.[0] ?? 1);
      const off = Number((eD.attrs['add_offset']?.value as number[] | undefined)?.[0] ?? 0);
      for (let i = 0; i < lat.length; i++) {
        if (qc && qc[i] !== 0) continue; // 0 = good; everything else is degraded/suspect
        const joules = raw[i]! * sf + off;
        flashes.push({
          lon: Math.round(lon[i]! * 100) / 100,
          lat: Math.round(lat[i]! * 100) / 100,
          mag: joules > 0 ? Math.round(Math.log10(joules) * 10) / 10 : -15,
          t: startMs,
        });
      }
    } finally {
      f.close();
    }
  } finally {
    h5fs!.unlink(name);
  }
  return flashes;
}

export interface LightningState {
  enabled: boolean;
  flashesInWindow: number;
  latestGranuleAgeS: number | null;
  sats: string[];
}

export class LightningLayer {
  private enabled = false;
  private loaded = false;
  private timer = 0;
  private flashes = new Map<string, Flash>();
  private lastKey = new Map<string, string>();
  private newestGranuleMs = 0;

  onChange: (() => void) | null = null;

  constructor(private map: MapLibreMap) {}

  get state(): LightningState {
    return {
      enabled: this.enabled,
      flashesInWindow: this.flashes.size,
      latestGranuleAgeS:
        this.newestGranuleMs > 0 ? Math.round((Date.now() - this.newestGranuleMs) / 1000) : null,
      sats: SATS.map((s) => s.label),
    };
  }

  async enable(): Promise<void> {
    if (this.enabled) return;
    registerLayer(ID, 'goes-glm');

    if (!this.loaded) {
      this.map.addSource(ID, { type: 'geojson', data: this.collection() });
      this.map.addLayer({
        id: ID,
        type: 'circle',
        source: ID,
        paint: {
          // Size by flash energy: log10(J) spans ~-15 (faint) to ~-11 (violent).
          'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], -15, 1.5, -13, 3, -11, 6],
          // Fade with age: fresh flashes near-white, old ones ember-dim.
          'circle-color': ['interpolate', ['linear'], ['get', 'ageMin'], 0, '#fffbe6', 2, '#ffd24a', 5, '#8a5a1a'],
          'circle-opacity': ['interpolate', ['linear'], ['get', 'ageMin'], 0, 0.95, 5, 0.25],
        },
      });
      this.loaded = true;
    } else {
      this.map.setLayoutProperty(ID, 'visibility', 'visible');
    }
    this.enabled = true;
    void this.poll();
    this.timer = window.setInterval(() => void this.poll(), POLL_MS);
    this.onChange?.();
  }

  disable(): void {
    if (!this.enabled) return;
    window.clearInterval(this.timer);
    if (this.map.getLayer(ID)) this.map.setLayoutProperty(ID, 'visibility', 'none');
    this.enabled = false;
    this.onChange?.();
  }

  private collection(): FeatureCollection<Point> {
    const now = Date.now();
    return {
      type: 'FeatureCollection',
      features: [...this.flashes.values()].map((fl) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [fl.lon, fl.lat] },
        properties: { mag: fl.mag, ageMin: Math.round(((now - fl.t) / 60_000) * 10) / 10 },
      })),
    };
  }

  private async poll(): Promise<void> {
    let changed = false;
    await Promise.all(
      SATS.map(async (sat) => {
        try {
          const key = await latestKey(sat.bucket);
          if (!key || this.lastKey.get(sat.id) === key) return;
          const startMs = keyStartMs(key);
          if (startMs === null) return;
          const r = await fetch(`${sat.bucket}/${key}`);
          if (!r.ok) return;
          const flashes = await parseGranule(await r.arrayBuffer(), startMs);
          this.lastKey.set(sat.id, key);
          this.newestGranuleMs = Math.max(this.newestGranuleMs, startMs);
          for (let i = 0; i < flashes.length; i++) {
            this.flashes.set(`${sat.id}:${startMs}:${i}`, flashes[i]!);
          }
          changed = true;
        } catch (err) {
          // Keep showing what we have; a missed 20 s granule heals on the next poll.
          console.warn(`[lightning] ${sat.id}:`, err);
        }
      }),
    );

    const cutoff = Date.now() - WINDOW_MS;
    for (const [k, fl] of this.flashes) {
      if (fl.t < cutoff) {
        this.flashes.delete(k);
        changed = true;
      }
    }

    // Ages advance even when nothing new arrived — the fade must not freeze.
    if (this.enabled && (changed || this.flashes.size > 0)) {
      (this.map.getSource(ID) as GeoJSONSource | undefined)?.setData(this.collection());
      this.onChange?.();
    }
  }
}
