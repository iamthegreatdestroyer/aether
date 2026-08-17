/**
 * The radar layer — LibreWXR primary, with the failover chain the plan calls mandatory.
 *
 * The chain is the design, not an accessory: LibreWXR is a single-operator FOSS service with
 * no SLA, carrying the nowcast and global coverage RainViewer dropped in January 2026. The
 * proposal's succession logic (§5.3.1) is implemented literally here —
 *
 *     librewxr  →  rainviewer (zoom ≤ 7, past 2 h only)  →  iem-nexrad (CONUS, 50-min loop)
 *
 * — and each provider's real error path is exercisable in dev by blocking its source at the
 * fetch layer (`__aether.block(['librewxr'])`), which is the P2 exit test.
 *
 * Rendering: raster tile sources in MapLibre itself. Radar frames repaint on camera and
 * timeline changes only, which is exactly what the basemap canvas is for — the second canvas
 * stays reserved for the particle engine's per-frame animation. Animation works by opacity
 * swap across per-frame layers: every frame's tiles stay warm in MapLibre's cache, so the
 * loop doesn't re-fetch on each tick.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { fetchJson } from '../data/fetcher';
import { source } from '../data/sources.mjs';
import { registerLayer } from './registry';

export interface RadarFrame {
  /** Epoch seconds of the frame's valid time. */
  time: number;
  /** True for nowcast (forecast) frames — styled differently in the timeline. */
  future: boolean;
  /** XYZ tile URL template. */
  tiles: string;
}

interface RadarProvider {
  id: string;
  label: string;
  maxzoom: number;
  load(): Promise<RadarFrame[]>;
}

/** RainViewer-v2-shaped index — served by both LibreWXR and RainViewer itself. */
interface RvIndex {
  host: string;
  radar?: {
    past?: Array<{ time: number; path: string }>;
    nowcast?: Array<{ time: number; path: string }>;
  };
}

/** Keep the loop tight: last 7 observed frames plus whatever nowcast exists. */
const PAST_FRAMES = 7;
/** Color scheme 2 (universal blue) + smoothing on, snow on — RainViewer v2 conventions. */
const TILE_SUFFIX = '/256/{z}/{x}/{y}/2/1_1.png';

function rvStyleProvider(sourceId: 'librewxr' | 'rainviewer', maxzoom: number): RadarProvider {
  const s = source(sourceId);
  return {
    id: sourceId,
    label: s.name,
    maxzoom,
    async load() {
      if (!s.baseUrl) throw new Error(`${sourceId} contract entry has no baseUrl`);
      const idx = await fetchJson<RvIndex>(sourceId, s.baseUrl);
      const past = (idx.radar?.past ?? []).slice(-PAST_FRAMES);
      const nowcast = idx.radar?.nowcast ?? [];
      const frames = [
        ...past.map((f) => ({ time: f.time, future: false, path: f.path })),
        ...nowcast.map((f) => ({ time: f.time, future: true, path: f.path })),
      ].map((f) => ({
        time: f.time,
        future: f.future,
        tiles: `${idx.host}${f.path}${TILE_SUFFIX}`,
      }));
      if (frames.length === 0) throw new Error(`${sourceId} returned an empty frame index`);
      return frames;
    },
  };
}

/**
 * Iowa IEM tile cache: no index endpoint — the -mNNm suffixed layers ARE the archive. A
 * probe tile is fetched first so an unreachable IEM fails the provider rather than producing
 * a layer of broken tiles. CONUS only; the plan calls it the zero-effort last resort.
 */
function iemProvider(): RadarProvider {
  const s = source('iem-nexrad');
  return {
    id: 'iem-nexrad',
    label: s.name,
    maxzoom: 12,
    async load() {
      if (!s.baseUrl) throw new Error('iem-nexrad contract entry has no baseUrl');
      const { blockedSources } = await import('../data/fetcher');
      if (blockedSources().has('iem-nexrad')) {
        throw new Error('iem-nexrad blocked (dev outage simulation)');
      }
      const probe = await fetch(`${s.baseUrl}/nexrad-n0q-900913/4/3/6.png`);
      if (!probe.ok) throw new Error(`IEM tile cache answered ${probe.status}`);

      const now = Math.floor(Date.now() / 1000);
      const suffixes = ['-m50m', '-m45m', '-m40m', '-m35m', '-m30m', '-m25m', '-m20m', '-m15m', '-m10m', '-m05m', ''];
      return suffixes.map((suffix, i) => ({
        time: now - (suffixes.length - 1 - i) * 300,
        future: false,
        tiles: `${s.baseUrl}/nexrad-n0q-900913${suffix}/{z}/{x}/{y}.png`,
      }));
    },
  };
}

const CHAIN: RadarProvider[] = [
  rvStyleProvider('librewxr', 10),
  rvStyleProvider('rainviewer', 7), // their hard zoom cap — enforced via source maxzoom
  iemProvider(),
];

const FRAME_MS = 600;
const LAST_FRAME_HOLD_MS = 1_400;
const INDEX_REFRESH_MS = 5 * 60 * 1000;
const OPACITY = 0.72;

export class RadarLayer {
  private frames: RadarFrame[] = [];
  private frameIndex = 0;
  private providerId: string | null = null;
  private providerLabel = '';
  private enabled = false;
  private playing = true;
  private timer = 0;
  private refreshTimer = 0;

  onChange: (() => void) | null = null;

  constructor(private map: MapLibreMap) {}

  get state() {
    return {
      enabled: this.enabled,
      provider: this.providerId,
      providerLabel: this.providerLabel,
      frames: this.frames.map((f) => ({ time: f.time, future: f.future })),
      frameIndex: this.frameIndex,
      playing: this.playing,
    };
  }

  async enable(): Promise<void> {
    if (this.enabled) return;
    await this.loadChain();
    this.enabled = true;
    this.buildLayers();
    this.setFrame(Math.max(0, this.frames.findIndex((f) => f.future) - 1));
    if (this.playing) this.startTimer();
    this.refreshTimer = window.setInterval(() => void this.refresh(), INDEX_REFRESH_MS);
    this.onChange?.();
  }

  disable(): void {
    if (!this.enabled) return;
    this.stopTimer();
    window.clearInterval(this.refreshTimer);
    this.removeLayers();
    this.enabled = false;
    this.onChange?.();
  }

  /** Walk the chain until a provider delivers frames. The order IS the succession plan. */
  private async loadChain(): Promise<void> {
    const errors: string[] = [];
    for (const provider of CHAIN) {
      try {
        this.frames = await provider.load();
        this.providerId = provider.id;
        this.providerLabel = provider.label;
        // Every provider switch goes through the registry door — licensing follows the
        // active source, and the denylist applies to fallbacks exactly as to primaries.
        registerLayer('radar', provider.id);
        if (errors.length > 0) {
          console.warn(`[radar] failover: ${errors.join('; ')} → using ${provider.id}`);
        }
        return;
      } catch (err) {
        errors.push(`${provider.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    throw new Error(`radar chain exhausted — ${errors.join('; ')}`);
  }

  private layerId(i: number): string {
    return `radar-frame-${i}`;
  }

  /** Insert under the first symbol layer so labels stay legible above the weather. */
  private beforeId(): string | undefined {
    return this.map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  }

  private buildLayers(): void {
    const provider = CHAIN.find((p) => p.id === this.providerId);
    const attribution = source(this.providerId!).attribution ?? this.providerLabel;
    const before = this.beforeId();
    this.frames.forEach((frame, i) => {
      this.map.addSource(this.layerId(i), {
        type: 'raster',
        tiles: [frame.tiles],
        tileSize: 256,
        maxzoom: provider?.maxzoom ?? 10,
        attribution,
      });
      this.map.addLayer(
        {
          id: this.layerId(i),
          type: 'raster',
          source: this.layerId(i),
          paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 0 } },
        },
        before,
      );
    });
  }

  private removeLayers(): void {
    this.frames.forEach((_, i) => {
      const id = this.layerId(i);
      if (this.map.getLayer(id)) this.map.removeLayer(id);
      if (this.map.getSource(id)) this.map.removeSource(id);
    });
  }

  setFrame(i: number): void {
    if (!this.enabled || this.frames.length === 0) return;
    this.frameIndex = ((i % this.frames.length) + this.frames.length) % this.frames.length;
    this.frames.forEach((_, k) => {
      this.map.setPaintProperty(
        this.layerId(k),
        'raster-opacity',
        k === this.frameIndex ? OPACITY : 0,
      );
    });
    this.onChange?.();
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    this.stopTimer();
    if (playing && this.enabled) this.startTimer();
    this.onChange?.();
  }

  private startTimer(): void {
    const tick = () => {
      const atEnd = this.frameIndex === this.frames.length - 1;
      this.setFrame(this.frameIndex + 1);
      this.timer = window.setTimeout(tick, atEnd ? FRAME_MS : this.frameIndex === this.frames.length - 1 ? LAST_FRAME_HOLD_MS : FRAME_MS);
    };
    this.timer = window.setTimeout(tick, FRAME_MS);
  }

  private stopTimer(): void {
    window.clearTimeout(this.timer);
  }

  /** Re-walk the chain: picks up new frames AND recovers to a better provider if one is back. */
  async refresh(): Promise<void> {
    if (!this.enabled) return;
    const wasPlaying = this.playing;
    this.stopTimer();
    this.removeLayers();
    try {
      await this.loadChain();
      this.buildLayers();
      this.setFrame(Math.max(0, this.frames.findIndex((f) => f.future) - 1));
      if (wasPlaying) this.startTimer();
    } catch (err) {
      this.enabled = false;
      console.error('[radar] refresh failed:', err);
    }
    this.onChange?.();
  }
}
