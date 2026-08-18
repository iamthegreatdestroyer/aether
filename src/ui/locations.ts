/**
 * Saved locations — localStorage-backed, capped at 10.
 *
 * The cap comes from the research's offline-cache sizing (ten locations of 7-day hourly fit
 * well under 100 KB), not from a UI whim. Locations are added by clicking the map — which
 * deliberately avoids the Open-Meteo *geocoding* sub-product: that one is CC BY-NC 4.0,
 * stricter than the weather data, and P0 simply doesn't need it.
 */

export interface SavedLocation {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

const STORAGE_KEY = 'aether.locations';
export const MAX_LOCATIONS = 10;

/** Neutral seeds spanning three continents — replace with your own by add/remove. */
const DEFAULTS: SavedLocation[] = [
  { id: 'nyc', name: 'New York', lat: 40.71, lon: -74.01 },
  { id: 'lon', name: 'London', lat: 51.51, lon: -0.13 },
  { id: 'tyo', name: 'Tokyo', lat: 35.68, lon: 139.69 },
];

export function loadLocations(): SavedLocation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULTS];
    const parsed = JSON.parse(raw) as SavedLocation[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [...DEFAULTS];
  } catch {
    return [...DEFAULTS];
  }
}

function save(locations: SavedLocation[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(locations));
}

export function addLocation(
  locations: SavedLocation[],
  name: string,
  lat: number,
  lon: number,
): SavedLocation[] {
  if (locations.length >= MAX_LOCATIONS) {
    throw new Error(`Location cap is ${MAX_LOCATIONS} — remove one first.`);
  }
  const next: SavedLocation = {
    id: `loc-${Date.now().toString(36)}`,
    name: name.trim() || `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
    lat: +lat.toFixed(4),
    lon: +lon.toFixed(4),
  };
  const updated = [...locations, next];
  save(updated);
  return updated;
}

/**
 * Pin the device's position as "Home" — a stable-id upsert, always moved to the front so it
 * is the first card and first hydrated. Coordinates round to 2 decimals (~1 km, same as the
 * default cities) ON PURPOSE: locationKey feeds the verification ledger, and 4-decimal
 * precision would let ordinary GPS jitter between re-pins mint a fresh ledger each time.
 * ~1 km is beyond weather-model resolution anyway.
 */
export function setHomeLocation(
  locations: SavedLocation[],
  lat: number,
  lon: number,
): SavedLocation[] {
  const existing = locations.find((l) => l.id === 'home');
  if (!existing && locations.length >= MAX_LOCATIONS) {
    throw new Error(`Location cap is ${MAX_LOCATIONS} — remove one first.`);
  }
  const home: SavedLocation = {
    id: 'home',
    name: '📍 Home',
    lat: +lat.toFixed(2),
    lon: +lon.toFixed(2),
  };
  const updated = [home, ...locations.filter((l) => l.id !== 'home')];
  save(updated);
  return updated;
}

/**
 * Rename without touching coordinates — deliberately. locationKey is built from lat/lon, so
 * a rename must never move a location: months of ledger receipts, climatology and captured
 * observations all hang off that key, and a typo fix should not orphan them.
 */
export function renameLocation(
  locations: SavedLocation[],
  id: string,
  name: string,
): SavedLocation[] {
  const updated = locations.map((l) => (l.id === id ? { ...l, name: name.trim() || l.name } : l));
  save(updated);
  return updated;
}

export function removeLocation(locations: SavedLocation[], id: string): SavedLocation[] {
  const updated = locations.filter((l) => l.id !== id);
  save(updated);
  return updated;
}

/** Stable key for ledger + latest-snapshot stores. Coordinates, not the editable name. */
export function locationKey(loc: SavedLocation): string {
  return `${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`;
}
