/**
 * Aether — canonical data-source contract.
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH for every external endpoint the app touches.
 * Nothing in the app may hard-code a weather URL; import from here instead.
 *
 * It is authored as plain ESM (with JSDoc types + an adjacent `sources.d.ts`) rather than
 * TypeScript for one deliberate reason: `scripts/probe-sources.mjs` and its CI job must be
 * able to import it with ZERO build step and ZERO dependencies. A contract that needs a
 * toolchain to verify is a contract that stops being verified.
 *
 * Every `status` / `cors` value below is a first-hand measurement, not a documentation claim.
 * See ACTION_PLAN.md §0 and §4. Method: GET with an `Origin:` header, reading the response
 * code and `Access-Control-Allow-Origin`. Never HEAD — HEAD gave false "no CORS" negatives
 * for SondeHub and met.no.
 *
 * tier:
 *   'A'        direct keyless call from the browser — CORS-open, verified
 *   'A-native' direct in Tauri native builds (native HTTP stacks ignore CORS);
 *              needs the Cloudflare Worker proxy in the PWA build
 *   'B'        server-side only (GRIB / bulk); never called from the client
 */

/** @type {import('./sources.d.ts').Source[]} */
export const SOURCES = [
  // ---------------------------------------------------------------- forecast
  {
    id: 'open-meteo',
    name: 'Open-Meteo',
    role: 'Forecast, ensemble, archive, air quality, picker',
    // The app builds its request URLs from this, never from a literal — ground rule #1.
    baseUrl: 'https://api.open-meteo.com/v1/forecast',
    probeUrl:
      'https://api.open-meteo.com/v1/forecast?latitude=40.7&longitude=-74.0&hourly=temperature_2m',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    license: 'Data CC BY 4.0; hosted free tier is non-commercial only',
    attribution: 'Weather data by Open-Meteo.com',
    attributionUrl: 'https://open-meteo.com/',
    rateLimit: '10,000 calls/day, 5,000/hr, 600/min',
    notes:
      'Server code is AGPLv3 — self-hosting is the escape hatch if the tier changes. ' +
      'The geocoding sub-product is CC BY-NC 4.0, stricter than the weather data.',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'nws-points',
    name: 'NWS api.weather.gov (points)',
    role: 'US gridpoint resolution + station observations (the truth side of the ledger in the US)',
    baseUrl: 'https://api.weather.gov',
    probeUrl: 'https://api.weather.gov/points/40.7,-74.0',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    license: 'US Government work — public domain',
    attribution: null,
    rateLimit: 'fair use',
    notes: 'Descriptive User-Agent with contact info is required by their policy.',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'nws-alerts',
    name: 'NWS api.weather.gov (alerts)',
    role: 'US CAP alerts with polygons',
    probeUrl: 'https://api.weather.gov/alerts/active?area=NY',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    license: 'US Government work — public domain',
    attribution: null,
    rateLimit: 'fair use',
    notes: 'Tier B cron polls this every 15 min for the FCM push lane.',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'met-no',
    name: 'MET Norway Locationforecast 2.0',
    role: 'Nordic-strong global forecast; nowcast',
    probeUrl: 'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=60&lon=11',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    license: 'CC BY 4.0 + NLOD 2.0',
    attribution: 'MET Norway',
    rateLimit: 'polite; identifying User-Agent MANDATORY or you get blocked',
    notes:
      'CORRECTION vs proposal dim08, which recorded no CORS header and classed this native-only. ' +
      'Measured CORS `*` on 2026-08-16 — usable directly from the PWA. ' +
      'The name "Yr" is banned in app names; "Aether" complies.',
    verifiedAt: '2026-08-16',
  },

  {
    id: 'open-meteo-archive',
    name: 'Open-Meteo ERA5 archive',
    role: '"Is this weird?" — per-location climatology back to 1940',
    baseUrl: 'https://archive-api.open-meteo.com/v1/archive',
    probeUrl:
      'https://archive-api.open-meteo.com/v1/archive?latitude=40.7&longitude=-74.0&start_date=2024-08-01&end_date=2024-08-07&daily=temperature_2m_max',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    minBytes: 200,
    license: 'Data CC BY 4.0 (ERA5: Copernicus/ECMWF via Open-Meteo); free tier non-commercial',
    attribution: 'Weather data by Open-Meteo.com',
    attributionUrl: 'https://open-meteo.com/',
    rateLimit: 'shares the Open-Meteo 10k/day pool; ONE full-history call per location, cached forever',
    notes:
      'Separate HOST from the forecast API — archive-api.open-meteo.com. Verified 2026-08-17: ' +
      'CORS *, and the full 1940-2024 daily tmax+tmin history for one point is 698 KB raw / ' +
      '~162 KB gzipped, served in under 2 s. Fetched once per location and cached permanently ' +
      'in IndexedDB — climatology does not change. Same attribution string as the forecast ' +
      'entry on purpose; requiredAttributions() dedupes by text.',
    verifiedAt: '2026-08-17',
  },

  {
    id: 'open-meteo-ensemble',
    name: 'Open-Meteo ensemble (GFS members)',
    role: 'Honesty labels — per-day predictability from real ensemble spread',
    baseUrl: 'https://ensemble-api.open-meteo.com/v1/ensemble',
    probeUrl:
      'https://ensemble-api.open-meteo.com/v1/ensemble?latitude=40.7&longitude=-74.0&hourly=temperature_2m&models=gfs_seamless&forecast_days=1',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    minBytes: 500,
    license: 'Data CC BY 4.0; free tier non-commercial',
    attribution: 'Weather data by Open-Meteo.com',
    attributionUrl: 'https://open-meteo.com/',
    rateLimit: 'shares the Open-Meteo pool; 3 h TTL cache per location',
    notes:
      'Third Open-Meteo host in the contract (forecast / archive / ensemble). Verified ' +
      '2026-08-17: CORS *, 7 days x 31 GFS members x 2 vars = 8.3 KB gzipped. Member series ' +
      'naming: temperature_2m, then temperature_2m_member01..member30. Attribution dedupes ' +
      'with the other Open-Meteo entries.',
    verifiedAt: '2026-08-17',
  },

  // ------------------------------------------------------- radar / satellite
  {
    id: 'librewxr',
    name: 'LibreWXR',
    role: 'PRIMARY radar + 2h nowcast + GMGSI satellite + global alerts',
    baseUrl: 'https://api.librewxr.net/public/weather-maps.json',
    probeUrl: 'https://api.librewxr.net/public/weather-maps.json',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    license: 'CC BY 4.0 (Italian DPC tiles: CC BY-SA 4.0); software AGPL-3.0',
    attribution: 'LibreWXR',
    rateLimit: 'undocumented — cache aggressively',
    notes:
      'Single-operator FOSS service, NO SLA. This is the project\'s largest structural ' +
      'dependency risk. Failover chain rainviewer -> iem-nexrad is mandatory, not optional. ' +
      'Display "Radar-DPC" whenever Italian tiles are shown. ' +
      'Verified 2026-08-16: returns {"version":"2.0"}, RainViewer-v2-compatible, 10-min frames.',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'rainviewer',
    name: 'RainViewer (fallback 1)',
    role: 'Radar fallback',
    baseUrl: 'https://api.rainviewer.com/public/weather-maps.json',
    probeUrl: 'https://api.rainviewer.com/public/weather-maps.json',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    license: 'Personal / educational / small-community use only',
    attribution: 'Weather data by RainViewer',
    attributionUrl: 'https://www.rainviewer.com/',
    rateLimit: '100 req/IP/min; zoom <= 7; past 2 h only',
    notes:
      'Attribution + link are MANDATORY under their terms. Jan-2026 retrenchment removed ' +
      'nowcast, satellite and composites — this is why LibreWXR is primary.',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'iem-nexrad',
    name: 'Iowa State IEM NEXRAD WMS-T (fallback 2)',
    role: 'US radar fallback + archive to 1995',
    // Tile cache root (TMS). The -m05m..-m50m suffixed layers give a 50-minute loop.
    baseUrl: 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0',
    probeUrl:
      'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi?service=WMS&request=GetCapabilities',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    license: 'NWS-derived public data, fair use',
    attribution: 'Iowa Environmental Mesonet',
    rateLimit: 'fair use',
    notes: 'CONUS only. Zero-effort last resort in the radar failover chain.',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'nasa-gibs',
    name: 'NASA GIBS WMTS',
    role: 'Satellite imagery (GOES GeoColor, Himawari B13, MODIS/VIIRS)',
    baseUrl: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best',
    probeUrl:
      'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    license: 'Free and open, NASA attribution',
    attribution: 'NASA GIBS/Worldview',
    rateLimit: 'no published limit',
    notes: 'Must not imply NASA endorsement.',
    verifiedAt: '2026-08-16',
  },

  // ------------------------------------------------------------ space weather
  {
    id: 'swpc-kp-estimate',
    baseUrl: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
    name: 'SWPC planetary K index (ESTIMATE)',
    role: 'Solar Chain — Kp strip, browser-reachable path',
    probeUrl: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    license: 'Public domain',
    attribution: null,
    rateLimit: 'polite',
    notes:
      'NOAA planetary K is an ESTIMATE. The official Kp producer is GFZ Potsdam. ' +
      'UI copy MUST label this as an estimate whenever GFZ is unavailable (see gfz-kp).',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'gfz-kp',
    name: 'GFZ Potsdam Kp (OFFICIAL)',
    role: 'Solar Chain — authoritative Kp',
    probeUrl:
      'https://kp.gfz.de/app/json/?start=2026-08-15T00:00:00Z&end=2026-08-16T00:00:00Z&index=Kp',
    tier: 'A-native',
    cors: 'none',
    expectStatus: [200],
    license: 'CC BY 4.0 (returned live in meta.license)',
    attribution: 'GFZ German Research Centre for Geosciences',
    rateLimit: 'polite',
    notes:
      'CORRECTION vs proposal Table 5.1, which schedules this as a Tier A client fetch. ' +
      'Measured 2026-08-16: HTTP 200 but NO Access-Control-Allow-Origin header. ' +
      'PWA must proxy it (Cloudflare Worker) or fall back to swpc-kp-estimate labelled ' +
      'as an estimate. Direct in Tauri native builds.',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'swpc-wind-summary',
    baseUrl: 'https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json',
    name: 'SWPC solar wind speed (summary)',
    role: 'Solar Chain — DEFAULT live solar-wind value',
    probeUrl: 'https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    minBytes: 40,
    license: 'Public domain',
    attribution: null,
    rateLimit: '1-minute cadence — do not poll faster',
    notes:
      'MEASURED 59 BYTES. Use this for the live number and the polling loop. ' +
      'The full 1-minute history (swpc-solar-wind-detail) is 2.7 MB — 46,000x larger — ' +
      'and must never be on a refresh loop.',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'swpc-mag-summary',
    baseUrl: 'https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json',
    name: 'SWPC IMF Bt/Bz (summary)',
    role: 'Solar Chain — DEFAULT live IMF value',
    probeUrl: 'https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    minBytes: 40,
    license: 'Public domain',
    attribution: null,
    rateLimit: '1-minute cadence',
    notes: 'MEASURED 60 BYTES. Bz southward is the aurora trigger — this is the value that matters.',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'swpc-solar-wind-detail',
    name: 'SWPC RTSW solar wind, full history (DSCOVR/ACE plasma)',
    role: 'Solar Chain — ON-DEMAND sparkline detail only',
    probeUrl: 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    minBytes: 10_000,
    license: 'Public domain',
    attribution: null,
    rateLimit: 'ON DEMAND ONLY — never on a polling loop',
    notes:
      'CORRECTED PATH. The proposal cites /products/solar-wind/plasma-1-day.json, which ' +
      'returns 404 as of 2026-08-16 (as do plasma-2-hour, plasma-7-day, mag-2-hour, and ' +
      'the plausible-looking /json/rtsw/rtsw_wind_5m.json). NOAA migrated real-time solar ' +
      'wind to the /json/rtsw/ namespace. The rest of the /products/ tree is still alive. ' +
      'PAYLOAD WARNING: measured 2,708 KB / 3,749 records — a 24 h rolling window at 1-min ' +
      'cadence. Fetch only when the user opens the detailed sparkline, then cache.',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'swpc-mag-detail',
    name: 'SWPC RTSW magnetometer, full history',
    role: 'Solar Chain — ON-DEMAND IMF Bz history',
    probeUrl: 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    minBytes: 10_000,
    license: 'Public domain',
    attribution: null,
    rateLimit: 'ON DEMAND ONLY',
    notes:
      'Same corrected /json/rtsw/ namespace. PAYLOAD WARNING: measured 1,526 KB. ' +
      'Use swpc-mag-summary for the live value.',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'swpc-xray',
    name: 'GOES X-ray flux',
    role: 'Solar Chain — flare activity',
    probeUrl: 'https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    license: 'Public domain',
    attribution: null,
    rateLimit: 'polite',
    notes: '',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'swpc-alerts',
    name: 'SWPC space weather alerts',
    role: 'Solar Chain — storm alerts',
    probeUrl: 'https://services.swpc.noaa.gov/products/alerts.json',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    license: 'Public domain',
    attribution: null,
    rateLimit: 'polite',
    notes: '',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'ovation-aurora',
    baseUrl: 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json',
    name: 'NOAA OVATION aurora',
    role: 'Solar Chain — auroral oval, crossed with cloud forecast',
    probeUrl: 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    license: 'Public domain',
    attribution: null,
    rateLimit: '~5-min model refresh',
    notes:
      'PAYLOAD WARNING: measured 919,721 bytes on 2026-08-16. That is ~0.9 MB per fetch on ' +
      'a phone. Fetch ON DEMAND when the aurora card opens — never on a polling loop. ' +
      'Consider decimating the grid server-side in Tier B.',
    verifiedAt: '2026-08-16',
  },

  // ------------------------------------------------------------ observations
  {
    id: 'sondehub',
    baseUrl: 'https://api.v2.sondehub.org',
    name: 'SondeHub v2',
    role: 'Balloon Truth — live radiosonde ascents',
    probeUrl: 'https://api.v2.sondehub.org/sondes/telemetry?duration=1h',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    minBytes: 1_000,
    mustNotContain: 'Duration must be',
    license: 'CC BY-SA 2.0',
    attribution: 'SondeHub (CC BY-SA 2.0)',
    rateLimit: 'polite — do not hammer',
    notes:
      'SHARE-ALIKE IS ACTIVE. Display sonde data ALONGSIDE model data; never blend the two ' +
      'into a derived product, or CC BY-SA 2.0 propagates. Any exported sonde archive is ' +
      'relicensed CC BY-SA 2.0. /amateur/telemetry also verified 200 + CORS `*`. ' +
      'GOTCHA: `duration` is an ENUM, not seconds. Valid: 3d, 1d, 12h, 6h, 3h, 1h, 30m, ' +
      '1m, 15s, 0. An invalid value returns HTTP 200 with the plain-text body ' +
      '"Duration must be either ..." — which is exactly why this contract asserts ' +
      'minBytes/mustNotContain and not status alone. Measured 82 KB at duration=1h.',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'sensor-community',
    name: 'Sensor.Community',
    role: 'Hyperlocal obs + PM for Smoke Story and the ledger',
    baseUrl: 'https://data.sensor.community/airrohr/v1/filter',
    probeUrl:
      'https://data.sensor.community/airrohr/v1/filter/box=52.4,13.3,52.6,13.5',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    license: 'Database Contents License, attribution',
    attribution: 'Sensor.Community',
    rateLimit: '~2.5 min per sensor cadence',
    notes: 'Used instead of PurpleAir, which went to paid points billing in Nov 2023.',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'aviationweather',
    name: 'aviationweather.gov (AWC)',
    role: 'METAR/TAF — the ledger\'s observation truth side',
    probeUrl: 'https://aviationweather.gov/api/data/metar?ids=KJFK&format=json',
    tier: 'A-native',
    cors: 'none',
    expectStatus: [200],
    license: 'Public domain',
    attribution: null,
    rateLimit: 'fair use',
    notes:
      'CONFIRMED no Access-Control-Allow-Origin header (2026-08-16) — matches the proposal. ' +
      'This is on the P3 critical path because the verification ledger scores against METARs. ' +
      'Resolve the proxy-vs-native decision at P3 START, not P3 end.',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'celestrak',
    name: 'CelesTrak GP element sets',
    role: 'Satellite passes (there is no public SpaceX telemetry API — this is the real answer)',
    probeUrl: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    license: 'Free; no formal attribution',
    attribution: null,
    rateLimit: 'HARD 2-hour polling floor; no bulk scraping',
    notes: 'Cache for >= 2 h. Violating the polling floor gets you blocked.',
    verifiedAt: '2026-08-16',
  },

  {
    id: 'nhc-storms',
    name: 'NOAA NHC/CPHC ATCF',
    role: 'Storm ledger — active storms, best tracks (truth), public model aids (forecasts)',
    baseUrl: 'https://www.nhc.noaa.gov',
    probeUrl: 'https://www.nhc.noaa.gov/CurrentStorms.json',
    tier: 'B',
    cors: 'none',
    expectStatus: [200],
    minBytes: 20,
    license: 'US Government work — public domain',
    attribution: null,
    rateLimit: 'advisories update 6-hourly; the cron matches that cadence',
    notes:
      'No CORS header (verified 2026-08-17) — Tier B mirrors to data/storms/ledger.json, the ' +
      'client reads same-origin. Decks at ftp.nhc.noaa.gov/atcf/{btk,aid_public}. ECMWF ' +
      'tracks are NOT in the public a-decks (licensed) — the ledger says so rather than ' +
      'scoring a quietly diminished field.',
    verifiedAt: '2026-08-17',
  },

  // ---------------------------------------------------------------- basemap
  {
    id: 'openfreemap',
    name: 'OpenFreeMap',
    role: 'Basemap style + tiles',
    // Dark, not liberty: the spike measured particles at 7% pixel coverage rendering
    // invisibly on a light basemap. Every product in this space uses a dark ground.
    baseUrl: 'https://tiles.openfreemap.org/styles/dark',
    probeUrl: 'https://tiles.openfreemap.org/styles/liberty',
    tier: 'A',
    cors: 'open',
    expectStatus: [200],
    license: 'ODbL (OpenStreetMap data)',
    attribution: '© OpenStreetMap contributors',
    rateLimit: 'free, no key',
    notes: 'Protomaps/PMTiles is the offline-bundle alternative for P6.',
    verifiedAt: '2026-08-16',
  },

  // -------------------------------------------------------- Tier B (server)
  {
    id: 'ecmwf-opendata',
    name: 'ECMWF Open Data (IFS + AIFS)',
    role: 'AI-vs-physics Divergence Layer (P5)',
    probeUrl: 'https://data.ecmwf.int/forecasts/',
    tier: 'B',
    cors: 'none',
    expectStatus: [200, 429],
    license: 'CC BY 4.0 since 2025-10-01',
    attribution:
      'This service is based on data and products of ECMWF',
    rateLimit: '500 simultaneous connections portal-wide',
    notes:
      'Measured HTTP 429 on a single probe 2026-08-16 — the portal cap is real and reachable. ' +
      'The Tier B cron needs retry-with-backoff from its first commit. ' +
      'FULL attribution is a LEGAL requirement even in a private app: the service wording ' +
      'above, plus "© [year] ECMWF", the CC BY 4.0 link, and a note of any modifications.',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'nomads-gfs',
    name: 'NOAA NOMADS GFS filter',
    role: 'Tier B — U/V wind textures for the particle layer (P1)',
    probeUrl: 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl',
    tier: 'B',
    cors: 'none',
    expectStatus: [200],
    license: 'Public domain',
    attribution: null,
    rateLimit: 'fair use — subset, never full grids',
    notes: 'Always use the filter/subset CGI so the runner downloads KB, not GB.',
    verifiedAt: '2026-08-16',
  },
];

/** Sources reachable directly from a browser today. */
export const TIER_A = SOURCES.filter((s) => s.tier === 'A');

/** Sources that need the Worker proxy in the PWA, or a Tauri native build. */
export const NEEDS_PROXY = SOURCES.filter((s) => s.tier === 'A-native');

/** @param {string} id */
export function source(id) {
  const s = SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown data source: ${id}`);
  return s;
}

/**
 * Every attribution string that must appear on the Data Sources screen.
 * Deduped by display text: the forecast and archive APIs are both Open-Meteo and share one
 * legally-required string — one obligation, one row, even though the contract tracks them as
 * separate endpoints with separate probes.
 */
export function requiredAttributions() {
  const seen = new Set();
  const out = [];
  for (const s of SOURCES) {
    if (!s.attribution || seen.has(s.attribution)) continue;
    seen.add(s.attribution);
    out.push({
      id: s.id,
      name: s.name,
      text: s.attribution,
      url: s.attributionUrl ?? null,
      license: s.license,
    });
  }
  return out;
}
