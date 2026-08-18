/**
 * Forecast card — one saved location's current conditions + 3-day outlook.
 *
 * Renders from whatever it is given and says where it came from: a card fed from the offline
 * snapshot carries a visible "cached" badge with the snapshot age. Silently presenting stale
 * data as live would be a small lie, and this app's entire identity is receipts.
 */

import { describeWeather } from '../data/openmeteo';
import type { ForecastData } from '../data/openmeteo';
import type { Weirdness } from '../data/climatology';
import type { SavedLocation } from './locations';

export interface CardState {
  loc: SavedLocation;
  data: ForecastData | null;
  /** Epoch ms the data was fetched; null while loading. */
  fetchedAt: number | null;
  /** True when data came from the offline snapshot rather than the network. */
  stale: boolean;
  error: string | null;
  /** "Is this weird?" — today's forecast vs 85 years of local history. Null until computed. */
  weirdness: Weirdness | null;
}

function ageLabel(fetchedAt: number): string {
  const mins = Math.round((Date.now() - fetchedAt) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function dayName(iso: string): string {
  return new Date(`${iso}T12:00`).toLocaleDateString(undefined, { weekday: 'short' });
}

export function renderCard(state: CardState, onRemove: (id: string) => void): HTMLElement {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset['locId'] = state.loc.id;

  const head = document.createElement('header');
  const title = document.createElement('h2');
  title.textContent = state.loc.name;
  const remove = document.createElement('button');
  remove.className = 'card-remove';
  remove.title = `Remove ${state.loc.name}`;
  remove.setAttribute('aria-label', `Remove ${state.loc.name}`);
  remove.textContent = '×';
  remove.addEventListener('click', () => onRemove(state.loc.id));
  head.append(title, remove);
  el.append(head);

  if (state.error) {
    const err = document.createElement('p');
    err.className = 'card-error';
    err.textContent = state.error;
    el.append(err);
    return el;
  }

  if (!state.data) {
    const loading = document.createElement('p');
    loading.className = 'card-loading';
    loading.textContent = 'Loading…';
    el.append(loading);
    return el;
  }

  const { current, daily } = state.data;
  const weather = describeWeather(current.weather_code);

  const now = document.createElement('div');
  now.className = 'card-now';
  now.innerHTML = `
    <span class="temp">${Math.round(current.temperature_2m)}°</span>
    <span class="glyph" role="img" aria-label="${weather.label}">${weather.glyph}</span>
    <div class="now-detail">
      <div>${weather.label}</div>
      <div>feels ${Math.round(current.apparent_temperature)}° · ${Math.round(current.relative_humidity_2m)}% rh</div>
      <div>wind ${Math.round(current.wind_speed_10m)} km/h</div>
    </div>`;
  el.append(now);

  // "Is this weird?" — the normality chip. Quiet when normal, loud when the answer is yes:
  // the whole point is that "should you care?" usually answers "no", and saying so plainly
  // is what makes the loud days credible.
  if (state.weirdness) {
    const w = state.weirdness;
    const chip = document.createElement('div');
    const notable = w.label !== 'normal for the date';
    chip.className = `weird-chip ${notable ? 'is-notable' : ''}`;
    chip.title = `Forecast high = p${w.tmaxPct}, low = p${w.tminPct} of ${w.years} at this point`;
    chip.innerHTML = `<span class="weird-glyph">${w.glyph}</span> <b>${w.label}</b> — ${w.sentence}`;
    el.append(chip);
  }

  const days = document.createElement('div');
  days.className = 'card-days';
  for (let i = 0; i < Math.min(3, daily.time.length); i++) {
    const iso = daily.time[i];
    const code = daily.weather_code[i];
    const hi = daily.temperature_2m_max[i];
    const lo = daily.temperature_2m_min[i];
    const pp = daily.precipitation_probability_max[i];
    if (iso === undefined || code === undefined || hi === undefined || lo === undefined) continue;
    const d = describeWeather(code);
    const cell = document.createElement('div');
    cell.className = 'day';
    cell.innerHTML = `
      <div class="day-name">${i === 0 ? 'Today' : dayName(iso)}</div>
      <div class="day-glyph" role="img" aria-label="${d.label}">${d.glyph}</div>
      <div class="day-temps">${Math.round(hi)}° / ${Math.round(lo)}°</div>
      <div class="day-precip">${pp ?? 0}% 💧</div>`;
    days.append(cell);
  }
  el.append(days);

  const meta = document.createElement('footer');
  meta.className = 'card-meta';
  if (state.fetchedAt !== null) {
    meta.textContent = state.stale
      ? `cached · ${ageLabel(state.fetchedAt)}`
      : `updated ${ageLabel(state.fetchedAt)}`;
    if (state.stale) el.classList.add('is-stale');
  }
  el.append(meta);

  return el;
}
