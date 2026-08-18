/**
 * The desktop widget — a Windy-complex-style strip that lives ON the desktop.
 *
 * Design constraints that shaped it:
 *   - It is a SECOND Tauri window over the same origin, so localStorage is shared with the
 *     app: the °F/°C choice, the saved locations and the Home pin all apply with zero
 *     plumbing. The first location (Home if pinned) is what the widget shows.
 *   - It fetches Open-Meteo directly (CORS-open) on a 30-minute cadence — the same lane and
 *     politeness the app's cards use, one call per refresh.
 *   - It writes a `widget` line to the self-check file after its first successful render,
 *     because a window nobody can screenshot headlessly still has to prove it painted
 *     (the G0.6 files-are-the-truth-channel pattern, third application).
 */

import { fmtTemp, tempUnit } from '../ui/units';
import { describeWeather } from '../data/openmeteo';
import { loadLocations } from '../ui/locations';
import { source } from '../data/sources.mjs';

const REFRESH_MS = 30 * 60 * 1000;

interface DailyResp {
  current: { temperature_2m: number; weather_code: number };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: (number | null)[];
  };
}

function dayName(iso: string): string {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString(undefined, {
    weekday: 'short',
    timeZone: 'UTC',
  });
}

let reported = false;

async function refresh(): Promise<void> {
  const loc = loadLocations()[0];
  if (!loc) return;
  const el = (id: string) => document.getElementById(id)!;
  el('name').textContent = loc.name;

  try {
    const u = new URL(source('open-meteo').baseUrl!);
    u.searchParams.set('latitude', loc.lat.toFixed(4));
    u.searchParams.set('longitude', loc.lon.toFixed(4));
    u.searchParams.set('current', 'temperature_2m,weather_code');
    u.searchParams.set(
      'daily',
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    );
    u.searchParams.set('forecast_days', '5');
    u.searchParams.set('timezone', 'auto');
    const r = await fetch(u);
    if (!r.ok) throw new Error(`open-meteo ${r.status}`);
    const d = (await r.json()) as DailyResp;

    const w = describeWeather(d.current.weather_code);
    el('now').textContent = fmtTemp(d.current.temperature_2m);
    el('glyph').textContent = w.glyph;
    el('meta').innerHTML = `Open-Meteo<br>${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;

    el('days').innerHTML = d.daily.time
      .map((iso, i) => {
        const dw = describeWeather(d.daily.weather_code[i] ?? 0);
        const pp = d.daily.precipitation_probability_max[i] ?? 0;
        return `<div class="d" data-tauri-drag-region>
          <div class="n">${i === 0 ? 'Today' : dayName(iso)}</div>
          <div class="g">${dw.glyph}</div>
          <div class="t">${fmtTemp(d.daily.temperature_2m_min[i]!)}/<b>${fmtTemp(d.daily.temperature_2m_max[i]!)}</b></div>
          <div class="p"><i style="width:${pp}%"></i></div>
        </div>`;
      })
      .join('');

    if (!reported && '__TAURI_INTERNALS__' in window) {
      reported = true;
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('report', {
        payload: JSON.stringify({
          at: new Date().toISOString(),
          widget: 'rendered',
          location: loc.name,
          unit: tempUnit(),
          nowC: d.current.temperature_2m,
          days: d.daily.time.length,
        }),
      }).catch(() => undefined);
    }
  } catch (err) {
    el('days').innerHTML = `<div id="err">${err instanceof Error ? err.message : err}</div>`;
  }
}

/**
 * "Open ↗" raises the main window. A widget that cannot get you to the app is a dead end —
 * and the whole reason this is a second window of the same app rather than a separate
 * program is that the jump costs nothing.
 */
async function openMainWindow(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) return;
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const main = await WebviewWindow.getByLabel('main');
    if (!main) return;
    await main.unminimize().catch(() => undefined);
    await main.show();
    await main.setFocus();
  } catch (err) {
    console.warn('[widget] could not raise the main window', err);
  }
}

document.getElementById('open')?.addEventListener('click', () => void openMainWindow());

// The main app broadcasts unit changes; same-origin windows can just listen for storage.
window.addEventListener('storage', (e) => {
  if (e.key === 'aether.tempunit' || e.key === 'aether.locations') void refresh();
});

void refresh();
setInterval(() => void refresh(), REFRESH_MS);
