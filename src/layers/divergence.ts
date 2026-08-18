/**
 * The AI-vs-physics layer — |IFS − AIFS| painted on the map (proposal §4.1.4).
 *
 * Transparent where the two philosophies agree (<0.5 °C), warming through amber to magenta
 * where they part ways. The honest reading is printed in the legend: this is not an error
 * map — nobody knows yet which model is wrong — it is a *humility* map. Where it lights up,
 * hold the forecast loosely.
 *
 * Rendering: a single world-image source per lead (720×361 texture, ~40 KB), no tiles —
 * MapLibre's `image` source with corner coordinates covers a global equirect PNG exactly.
 * Textures come from the Tier B cron (ecCodes on the runner; CCSDS packing is beyond the
 * pure-Python decoder) with the committed set as last-known-good.
 */

import type { Map as MapLibreMap, ImageSource } from 'maplibre-gl';
import { registerLayer } from './registry';

const ID = 'divergence';

export interface DivergenceIndex {
  cycle: string;
  variable: string;
  units: string;
  leads: Array<{ lead: number; file: string; maxDiffC: number; meanDiffC: number; pctOver2C: number }>;
  bounds: [number, number, number, number];
  attribution: string;
  builtAt: string;
}

export class DivergenceLayer {
  private enabled = false;
  private index: DivergenceIndex | null = null;
  private lead = 24;

  onChange: (() => void) | null = null;

  constructor(private map: MapLibreMap) {}

  get state() {
    const row = this.index?.leads.find((l) => l.lead === this.lead) ?? null;
    return {
      enabled: this.enabled,
      lead: this.lead,
      leads: this.index?.leads.map((l) => l.lead) ?? [],
      cycle: this.index?.cycle ?? null,
      stats: row ? { max: row.maxDiffC, mean: row.meanDiffC, pctOver2C: row.pctOver2C } : null,
      attribution: this.index?.attribution ?? null,
    };
  }

  async enable(): Promise<void> {
    if (this.enabled) return;
    if (!this.index) {
      const r = await fetch('data/divergence/index.json');
      if (!r.ok) throw new Error('divergence textures not built yet — the 6-hourly cron will fill them in');
      this.index = (await r.json()) as DivergenceIndex;
    }
    registerLayer(ID, 'ecmwf-opendata');

    const [w, s, e, n] = this.index.bounds;
    this.map.addSource(ID, {
      type: 'image',
      url: this.url(),
      coordinates: [[w, n], [e, n], [e, s], [w, s]],
    });
    const before = this.map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    this.map.addLayer(
      { id: ID, type: 'raster', source: ID, paint: { 'raster-opacity': 0.75, 'raster-resampling': 'linear' } },
      before,
    );
    this.enabled = true;
    this.onChange?.();
  }

  disable(): void {
    if (!this.enabled) return;
    if (this.map.getLayer(ID)) this.map.removeLayer(ID);
    if (this.map.getSource(ID)) this.map.removeSource(ID);
    this.enabled = false;
    this.onChange?.();
  }

  setLead(lead: number): void {
    if (!this.index?.leads.some((l) => l.lead === lead)) return;
    this.lead = lead;
    if (this.enabled) {
      const src = this.map.getSource(ID) as ImageSource;
      src.updateImage({ url: this.url() });
    }
    this.onChange?.();
  }

  private url(): string {
    const row = this.index!.leads.find((l) => l.lead === this.lead)!;
    return `data/divergence/${row.file}`;
  }
}
