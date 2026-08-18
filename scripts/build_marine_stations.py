#!/usr/bin/env python3
"""
Bake the marine station directories into two small same-origin artifacts.

Two problems solved at once, both learned from earlier phases:

  1. NOAA's tide-station directory is **2.0 MB** of JSON (3,499 stations, each carrying
     affiliations, notices, disclaimers and product links). Making a phone download that on
     cellular to answer "what's the tide here" would be rude. Thinned to id/name/lat/lon it
     is a fraction of the size, and stations do not move.

  2. NDBC's realtime buoy files send NO CORS header (measured 2026-08-18) — the same wall as
     FIRMS. But NDBC also publishes `latest_obs.txt`: EVERY station's latest observation in
     one 106 KB file. Baking that hourly gives the browser same-origin access to every buoy
     on the planet, so nearest-buoy works for any location the owner ever pins, not just the
     ones we thought of.

Output (consumed by src/data/marine.ts):
  public/data/marine/stations.json — tide-prediction stations, thinned
  public/data/marine/buoys.json    — all buoys' latest observations, parsed to numbers
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TIDE_URL = (
    'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json'
    '?type=tidepredictions'
)
BUOY_URL = 'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt'
UA = 'Aether/0.2 (personal weather app; contact: sgbilod@gmail.com)'
RETRY_DELAYS_S = [3, 12, 40]


def fetch(url: str) -> bytes:
    last: Exception | None = None
    for attempt, delay in enumerate([0, *RETRY_DELAYS_S]):
        if delay:
            time.sleep(delay)
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 — retrying network errors is the point
            last = e
            print(f'  attempt {attempt + 1} failed: {e}', file=sys.stderr)
    raise RuntimeError(f'fetch failed after retries: {last}')


def num(tok: str) -> float | None:
    """NDBC writes 'MM' for missing. A missing value must stay missing, never 0."""
    try:
        return float(tok)
    except (TypeError, ValueError):
        return None


def build_tide_stations(out_dir: Path) -> int:
    raw = fetch(TIDE_URL)
    if not raw.lstrip().startswith(b'{'):
        raise RuntimeError('CO-OPS station directory did not return JSON')
    data = json.loads(raw)
    stations = [
        {
            'id': s['id'],
            'name': s['name'],
            'lat': round(float(s['lat']), 4),
            'lon': round(float(s['lng']), 4),
        }
        for s in data.get('stations', [])
        if s.get('id') and s.get('lat') is not None and s.get('lng') is not None
    ]
    if len(stations) < 500:
        raise RuntimeError(f'only {len(stations)} tide stations — directory looks truncated')
    payload = {
        'builtAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'source': 'NOAA CO-OPS tide prediction stations',
        'stations': stations,
    }
    out = out_dir / 'stations.json'
    out.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')
    print(f'wrote {out}: {len(stations)} stations, {out.stat().st_size:,} B '
          f'(from {len(raw):,} B upstream)')
    return len(stations)


def build_buoys(out_dir: Path) -> int:
    text = fetch(BUOY_URL).decode('utf-8', errors='replace')
    lines = [l for l in text.splitlines() if l.strip()]
    # Two comment lines carry the column names and their units.
    header = [l for l in lines if l.startswith('#')][:2]
    if not header:
        raise RuntimeError('NDBC latest_obs had no header — layout changed')

    buoys = []
    for line in lines:
        if line.startswith('#'):
            continue
        f = line.split()
        if len(f) < 19:
            continue
        lat, lon = num(f[1]), num(f[2])
        if lat is None or lon is None:
            continue
        try:
            obs_iso = (
                f'{int(f[3]):04d}-{int(f[4]):02d}-{int(f[5]):02d}'
                f'T{int(f[6]):02d}:{int(f[7]):02d}:00Z'
            )
        except ValueError:
            continue
        buoys.append(
            {
                'id': f[0],
                'lat': round(lat, 3),
                'lon': round(lon, 3),
                't': obs_iso,
                'windDir': num(f[8]),
                'windMs': num(f[9]),
                'gustMs': num(f[10]),
                'waveM': num(f[11]),
                'domPeriodS': num(f[12]),
                'avgPeriodS': num(f[13]),
                'waveDir': num(f[14]),
                'pressHpa': num(f[15]),
                'airC': num(f[17]),
                'waterC': num(f[18]),
            }
        )
    if len(buoys) < 200:
        raise RuntimeError(f'only {len(buoys)} buoys parsed — layout likely changed')

    payload = {
        'builtAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'source': 'NOAA NDBC latest observations',
        'buoys': buoys,
    }
    out = out_dir / 'buoys.json'
    out.write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')
    print(f'wrote {out}: {len(buoys)} buoys, {out.stat().st_size:,} B')
    return len(buoys)


def main() -> int:
    out_dir = Path('public/data/marine')
    out_dir.mkdir(parents=True, exist_ok=True)
    build_tide_stations(out_dir)
    build_buoys(out_dir)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
