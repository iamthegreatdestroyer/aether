/**
 * Open-Meteo forecast client — the P0 core source.
 *
 * One request per location carries everything P0 shows plus everything the ledger logs:
 * current conditions, 7 days hourly (the T+1 scoring grid), and 7 days daily. Measured cost
 * from the research: ~2.6 KB gzipped per location — data volume is a non-issue.
 */

import { source } from './sources.mjs';
import { fetchJson } from './fetcher';
import type { SavedLocation } from '../ui/locations';

export interface ForecastData {
  timezone: string;
  current: {
    time: string;
    temperature_2m: number;
    relative_humidity_2m: number;
    apparent_temperature: number;
    weather_code: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
  };
  hourly: {
    time: string[];
    temperature_2m: number[];
    precipitation: number[];
    precipitation_probability: number[];
    wind_speed_10m: number[];
    weather_code: number[];
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
  };
}

const CURRENT = [
  'temperature_2m',
  'relative_humidity_2m',
  'apparent_temperature',
  'weather_code',
  'wind_speed_10m',
  'wind_direction_10m',
].join(',');

const HOURLY = [
  'temperature_2m',
  'precipitation',
  'precipitation_probability',
  'wind_speed_10m',
  'weather_code',
].join(',');

const DAILY = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_probability_max',
].join(',');

export function forecastUrl(loc: SavedLocation): string {
  const om = source('open-meteo');
  if (!om.baseUrl) throw new Error('open-meteo contract entry has no baseUrl');
  const u = new URL(om.baseUrl);
  u.searchParams.set('latitude', loc.lat.toFixed(4));
  u.searchParams.set('longitude', loc.lon.toFixed(4));
  u.searchParams.set('current', CURRENT);
  u.searchParams.set('hourly', HOURLY);
  u.searchParams.set('daily', DAILY);
  u.searchParams.set('timezone', 'auto');
  u.searchParams.set('forecast_days', '7');
  return u.toString();
}

export function fetchForecast(loc: SavedLocation): Promise<ForecastData> {
  return fetchJson<ForecastData>('open-meteo', forecastUrl(loc));
}

/**
 * WMO weather interpretation codes → label + glyph.
 * Groups per the WMO 4677 table Open-Meteo documents; unknown codes fall through honestly.
 */
const WMO: Array<[codes: number[], label: string, glyph: string]> = [
  [[0], 'Clear', '☀️'],
  [[1], 'Mostly clear', '🌤️'],
  [[2], 'Partly cloudy', '⛅'],
  [[3], 'Overcast', '☁️'],
  [[45, 48], 'Fog', '🌫️'],
  [[51, 53, 55], 'Drizzle', '🌦️'],
  [[56, 57], 'Freezing drizzle', '🌧️'],
  [[61, 63, 65], 'Rain', '🌧️'],
  [[66, 67], 'Freezing rain', '🌧️'],
  [[71, 73, 75, 77], 'Snow', '🌨️'],
  [[80, 81, 82], 'Rain showers', '🌦️'],
  [[85, 86], 'Snow showers', '🌨️'],
  [[95], 'Thunderstorm', '⛈️'],
  [[96, 99], 'Thunderstorm + hail', '⛈️'],
];

export function describeWeather(code: number): { label: string; glyph: string } {
  for (const [codes, label, glyph] of WMO) {
    if (codes.includes(code)) return { label, glyph };
  }
  return { label: `Code ${code}`, glyph: '❓' };
}
