#!/usr/bin/env python3
"""
Build the app's U/V wind texture from the latest published GFS cycle.

This is the Tier B pipeline's first real job (proposal §5.2.3): scheduled in CI, it fetches a
NOMADS filter subset (KB, not GB), decodes it with the validated pure-Python GRIB2 decoder,
and writes `public/data/wind/latest.{png,json}` — which the Pages build then ships as static
files. The client fetches them same-origin: no CORS, no tile server, no secrets.

The committed copy of latest.{png,json} is the dev fallback and the "last known good": a
fresh clone renders wind immediately, and a failed cron leaves the previous deploy's texture
in place rather than a broken layer.

Resilience notes, both earned:
  - A cycle that is not yet published returns an HTML error page, not GRIB — detected by
    magic bytes, then we walk back one cycle (up to 4).
  - NOMADS throttles; fetches retry with backoff. The ECMWF 429 in the endpoint probe proved
    these limits are enforced, not theoretical.

Encoding contract (shared with src/particles/engine.ts and the sidecar JSON):
  R = u scaled from [uMin,uMax], G = v scaled likewise, ONE symmetric range for both channels
  (uMin = vMin = -extent, uMax = vMax = +extent), longitudes rolled to [-180,180),
  rows north→south. The spike learned each of these the hard way; do not change one side only.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from grib2_decode import field_to_grid, parse_message, split_messages

NOMADS = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
UA = "Aether/0.1 (personal weather app; contact: sgbilod@gmail.com)"
RETRY_DELAYS_S = [2, 8, 30]


def candidate_cycles(now: datetime | None = None, count: int = 4):
    """Newest plausible GFS cycle first (published ~3.5–5 h after cycle time), then older."""
    now = now or datetime.now(timezone.utc)
    t = now - timedelta(hours=5)
    t = t.replace(hour=(t.hour // 6) * 6, minute=0, second=0, microsecond=0)
    for i in range(count):
        c = t - timedelta(hours=6 * i)
        yield c.strftime("%Y%m%d"), f"{c.hour:02d}"


def fetch_with_retry(url: str) -> bytes:
    last: Exception | None = None
    for attempt, delay in enumerate([0, *RETRY_DELAYS_S]):
        if delay:
            time.sleep(delay)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 — retrying network errors is the whole point
            last = e
            print(f"  attempt {attempt + 1} failed: {e}", file=sys.stderr)
    raise RuntimeError(f"fetch failed after retries: {last}")


def fetch_latest_grib() -> tuple[bytes, str, str]:
    """Try cycles newest-first until one returns actual GRIB."""
    for date, run in candidate_cycles():
        url = (
            f"{NOMADS}?file=gfs.t{run}z.pgrb2.0p25.f000"
            f"&lev_10_m_above_ground=on&var_UGRD=on&var_VGRD=on"
            f"&dir=%2Fgfs.{date}%2F{run}%2Fatmos"
        )
        print(f"trying GFS {date} {run}Z ...")
        raw = fetch_with_retry(url)
        if raw.startswith(b"GRIB"):
            print(f"  got {len(raw):,} bytes")
            return raw, date, run
        # Not-yet-published cycles answer 200 with an HTML notice — the SondeHub lesson
        # applies to NOMADS too: status is not proof of data.
        print(f"  not GRIB ({len(raw)} bytes) — cycle likely unpublished, walking back")
    raise RuntimeError("no publishable GFS cycle found in the last 24 h")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stride", type=int, default=4, help="grid decimation (4 -> 360x181, ~1 deg)")
    ap.add_argument("--out", default="public/data/wind/latest.png")
    args = ap.parse_args()

    raw, date, run = fetch_latest_grib()

    fields: dict[str, np.ndarray] = {}
    for msg in split_messages(raw):
        m = parse_message(msg)
        name = {(2, 2): "u", (2, 3): "v"}.get((m["category"], m["parameter"]))
        if name:
            fields[name] = field_to_grid(m)
            print(f"  decoded {name.upper()}GRD {m['nj']}x{m['ni']} template 5.{m['drt']}")

    if "u" not in fields or "v" not in fields:
        print("ERROR: missing UGRD or VGRD in response", file=sys.stderr)
        return 1

    s = args.stride
    u, v = fields["u"][::s, ::s], fields["v"][::s, ::s]
    half = u.shape[1] // 2
    u, v = np.roll(u, half, axis=1), np.roll(v, half, axis=1)

    extent = float(max(abs(u).max(), abs(v).max()))
    rgba = np.zeros((u.shape[0], u.shape[1], 4), dtype=np.uint8)
    rgba[..., 0] = np.round((u + extent) / (2 * extent) * 255).astype(np.uint8)
    rgba[..., 1] = np.round((v + extent) / (2 * extent) * 255).astype(np.uint8)
    rgba[..., 3] = 255

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(out, optimize=True)

    speed = np.hypot(u, v)
    sidecar = {
        "source": "NOAA/NCEP GFS 0.25deg via NOMADS filter CGI",
        "license": "public domain",
        "cycle": f"{date}T{run}00Z",
        "validTime": f"{date[0:4]}-{date[4:6]}-{date[6:8]}T{run}:00:00Z",
        "forecastHour": 0,
        "variable": "10 m wind",
        "width": int(u.shape[1]),
        "height": int(u.shape[0]),
        "uMin": -extent, "uMax": extent,
        "vMin": -extent, "vMax": extent,
        "maxSpeedMs": float(speed.max()),
        "lonRange": [-180, 180],
        "latRange": [90, -90],
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "decodedBy": "scripts/build_wind_texture.py (pure-python GRIB2 template 5.3)",
    }
    out.with_suffix(".json").write_text(json.dumps(sidecar, indent=2), encoding="utf-8")

    print(f"wrote {out} ({out.stat().st_size:,} B, {u.shape[1]}x{u.shape[0]})")
    print(f"wrote {out.with_suffix('.json')}  cycle {date}/{run}Z  max {speed.max():.1f} m/s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
