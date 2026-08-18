/**
 * Forecast card — one saved location's current conditions + 3-day outlook.
 *
 * Renders from whatever it is given and says where it came from: a card fed from the offline
 * snapshot carries a visible "cached" badge with the snapshot age. Silently presenting stale
 * data as live would be a small lie, and this app's entire identity is receipts.
 */

import { fmtTemp, temp, tempDelta, unitLabel } from './units';
import { describeWeather } from '../data/openmeteo';
import type { ForecastData } from '../data/openmeteo';
import type { Weirdness } from '../data/climatology';
import type { DayHonesty } from '../data/ensemble';
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
  /** Per-day honesty labels from real ensemble spread. Null until fetched. */
  honesty: DayHonesty[] | null;
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

/**
 * Which cards are expanded. Phones start every card COLLAPSED — the full card is 280 px
 * tall and three of them ate half a Galaxy S25+ screen (owner, 2026-08-18) — while desktop,
 * where the rail is a vertical column with room to spare, starts expanded. The choice is
 * remembered per location, so a card you care about stays open.
 */
const EXPANDED_KEY = 'aether.expandedCards';

function expandedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (raw === null) {
      // No stored preference yet: collapsed on phones, open on desktop.
      return window.matchMedia('(max-width: 700px)').matches ? new Set() : new Set(['*']);
    }
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set(['*']);
  }
}

export function isCardExpanded(id: string): boolean {
  const set = expandedSet();
  return set.has('*') || set.has(id);
}

function setCardExpanded(id: string, open: boolean, allIds: string[]): void {
  const set = expandedSet();
  // '*' is the "everything open" default; materialise it before removing one.
  if (set.has('*')) {
    set.delete('*');
    for (const i of allIds) set.add(i);
  }
  if (open) set.add(id);
  else set.delete(id);
  localStorage.setItem(EXPANDED_KEY, JSON.stringify([...set]));
}

export function renderCard(
  state: CardState,
  onRemove: (id: string) => void,
  onCone?: (loc: SavedLocation) => void,
  allIds: string[] = [],
  onToggle?: () => void,
): HTMLElement {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset['locId'] = state.loc.id;

  const expanded = isCardExpanded(state.loc.id);
  el.classList.toggle('is-collapsed', !expanded);

  const head = document.createElement('header');
  const caret = document.createElement('button');
  caret.className = 'card-caret';
  caret.setAttribute('aria-expanded', String(expanded));
  caret.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${state.loc.name}`);
  caret.textContent = expanded ? '▾' : '▸';
  caret.addEventListener('click', () => {
    setCardExpanded(state.loc.id, !isCardExpanded(state.loc.id), allIds);
    onToggle?.();
  });
  const title = document.createElement('h2');
  title.textContent = state.loc.name;
  const remove = document.createElement('button');
  remove.className = 'card-remove';
  remove.title = `Remove ${state.loc.name}`;
  remove.setAttribute('aria-label', `Remove ${state.loc.name}`);
  remove.textContent = '×';
  remove.addEventListener('click', () => onRemove(state.loc.id));
  if (onCone && state.data) {
    const cone = document.createElement('button');
    cone.className = 'card-cone';
    cone.title = 'Confidence cone — ensemble spread for this location';
    cone.setAttribute('aria-label', `Confidence cone for ${state.loc.name}`);
    cone.textContent = '📈';
    cone.addEventListener('click', () => onCone(state.loc));
    head.append(caret, title, cone, remove);
  } else {
    head.append(caret, title, remove);
  }
  // Collapsed, the header IS the card, so it has to carry the one number people open the
  // app for. Expanded, the big .card-now block below owns it and this would be a duplicate.
  if (!expanded && state.data) {
    const peek = document.createElement('span');
    peek.className = 'card-peek';
    peek.textContent = `${fmtTemp(state.data.current.temperature_2m)} ${describeWeather(state.data.current.weather_code).glyph}`;
    title.after(peek);
  }
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
    <span class="temp">${fmtTemp(current.temperature_2m)}</span>
    <span class="glyph" role="img" aria-label="${weather.label}">${weather.glyph}</span>
    <div class="now-detail">
      <div>${weather.label}</div>
      <div>feels ${fmtTemp(current.apparent_temperature)} · ${Math.round(current.relative_humidity_2m)}% rh</div>
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
    // Honesty badge: predictability that shows its work. The tooltip carries the full
    // derivation — members, spread, climatological yardstick — so the number is checkable.
    const h = state.honesty?.find((x) => x.date === iso) ?? null;
    // Built HERE, not in the data layer: the sentence names units, and units are a display
    // choice the user can flip at any moment (ui/units.ts). The range is absolute; both σ
    // values are spreads and must not take the +32 offset.
    const tip = h
      ? `${h.members} GFS ensemble members put the high at ` +
        `${temp(h.tmaxLo).toFixed(0)}–${temp(h.tmaxHi).toFixed(0)}${unitLabel()} ` +
        `(σ ${tempDelta(h.tmaxStd).toFixed(1)}${unitLabel()}). ` +
        (h.climStd !== null
          ? `Typical variability here for this date: σ ${tempDelta(h.climStd).toFixed(1)}${unitLabel()} ` +
            `(1940–2024) → ${h.predictabilityPct}% predictability.`
          : 'Climatology still loading — showing raw spread.') +
        (h.rainSplit ? ` Rain contested: ${h.wetMembers}/${h.precMembers} members wet.` : '')
      : '';
    const badge = h
      ? `<div class="day-pred ${h.predictabilityPct !== null && h.predictabilityPct < 40 ? 'is-low' : ''}"
           title="${tip.replace(/"/g, '&quot;')}">${
             h.predictabilityPct !== null ? `${h.predictabilityPct}%` : `±${tempDelta(h.tmaxStd).toFixed(1)}°`
           }${h.rainSplit ? ' ⚡' : ''}</div>`
      : '';
    cell.innerHTML = `
      <div class="day-name">${i === 0 ? 'Today' : dayName(iso)}</div>
      <div class="day-glyph" role="img" aria-label="${d.label}">${d.glyph}</div>
      <div class="day-temps">${fmtTemp(hi)} / ${fmtTemp(lo)}</div>
      <div class="day-precip">${pp ?? 0}% 💧</div>${badge}`;
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
