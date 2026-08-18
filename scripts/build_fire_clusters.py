#!/usr/bin/env python3
"""
Build the Smoke Story's fire layer from FIRMS VIIRS active-fire detections.

FIRMS's keyless data directory serves 24 h CSVs with NO CORS header (measured 2026-08-18:
global file 8.8 MB), so this is a Tier B lane: the cron thins detections into 0.25-degree
clusters and ships them as same-origin GeoJSON on Pages. Fires move slowly relative to the
6-hourly cadence; the panel prints the data's age rather than pretending it is live.

Output contract (consumed by src/layers/fires.ts and src/data/smoke.ts):
  public/data/fires/latest.json — GeoJSON FeatureCollection of Point clusters, properties
  {n: detection count, frp: summed fire radiative power MW}, plus foreign members
  {builtAt, source, window} MapLibre ignores and the panel reads.
"""

from __future__ import annotations

import csv
import io
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

URL = (
    "https://firms.modaps.eosdis.nasa.gov/data/active_fire/"
    "suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv"
)
UA = "Aether/0.1 (personal weather app; contact: sgbilod@gmail.com)"
BIN_DEG = 0.25
RETRY_DELAYS_S = [5, 20, 60]


def fetch() -> str:
    last: Exception | None = None
    for attempt, delay in enumerate([0, *RETRY_DELAYS_S]):
        if delay:
            time.sleep(delay)
        try:
            req = urllib.request.Request(URL, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read().decode("utf-8", errors="replace")
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"  attempt {attempt + 1} failed: {e}", file=sys.stderr)
    raise RuntimeError(f"FIRMS fetch failed after retries: {last}")


def main() -> int:
    text = fetch()
    if not text.startswith("latitude,"):
        # The SondeHub lesson: 200 with an error page is not data.
        raise RuntimeError(f"FIRMS answered non-CSV ({text[:80]!r})")

    bins: dict[tuple[int, int], list[float]] = {}  # (latBin, lonBin) -> [n, frpSum]
    rows = 0
    for row in csv.DictReader(io.StringIO(text)):
        try:
            lat, lon = float(row["latitude"]), float(row["longitude"])
            frp = float(row["frp"] or 0.0)
        except (KeyError, ValueError):
            continue
        rows += 1
        key = (int(lat // BIN_DEG), int(lon // BIN_DEG))
        b = bins.setdefault(key, [0, 0.0])
        b[0] += 1
        b[1] += frp

    features = [
        {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [
                    round((k[1] + 0.5) * BIN_DEG, 3),
                    round((k[0] + 0.5) * BIN_DEG, 3),
                ],
            },
            "properties": {"n": b[0], "frp": round(b[1], 1)},
        }
        for k, b in bins.items()
    ]
    fc = {
        "type": "FeatureCollection",
        "features": features,
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "NASA FIRMS, VIIRS (Suomi NPP) C2 NRT, 24 h window",
        "window": "24h",
        "detections": rows,
        "binDeg": BIN_DEG,
    }
    out = Path("public/data/fires/latest.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {out}: {rows:,} detections -> {len(features):,} clusters, {out.stat().st_size:,} B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
