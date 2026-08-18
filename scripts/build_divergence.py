#!/usr/bin/env python3
"""
The AI-vs-physics divergence layer (proposal §4.1.4) — the 2025–26-exclusive window.

Since 1 October 2025, ECMWF publishes BOTH its physics model (IFS) and its AI model
(AIFS-single) keyless under CC BY 4.0, co-registered on the same 0.25° grid, in the same
open-data tree. Two world-class forecasting philosophies free to differ — so the pixel-wise
|IFS − AIFS| 2 m temperature field is almost free to compute, and nowhere in the consumer
market (verified against Windy's live 68-overlay catalog during the recon). Where they
agree, confidence is real; where they diverge, something interesting is happening.

Mechanics, all live-verified before this file was written:
  - each step has an .index file of JSON lines with per-field byte offsets → one HTTP Range
    request fetches exactly the 2t message (~600 KB) instead of the multi-GB step file
  - both models pack with CCSDS/AEC (GRIB2 template 5.42) — beyond the pure-Python decoder,
    so this script requires ecCodes and runs in CI (Linux wheels bundle the library); the
    committed textures are the dev/offline fallback, same as wind and storms
  - the portal enforces its 500-connection cap with real 429s (met one on day one) —
    fetches retry with backoff, per the plan's standing requirement for this phase

Output: one colorized RGBA world PNG + sidecar per lead (24/48/72/96/120 h), ~40 KB each.
Transparent below 0.5 °C of disagreement — agreement is the quiet default, divergence is
the signal. ECMWF attribution obligations ride in the sidecar.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image

try:
    import eccodes  # noqa: F401 — Linux/CI dependency; Windows dev uses committed textures
    HAVE_ECCODES = True
except Exception:  # noqa: BLE001
    HAVE_ECCODES = False

BASE = "https://data.ecmwf.int/forecasts"
UA = "Aether/0.1 (personal weather app; contact: sgbilod@gmail.com)"
LEADS = [24, 48, 72, 96, 120]
RETRY_S = [2, 8, 30]
STRIDE = 2  # 0.5° output: 720×361, ~40 KB per PNG

# Divergence colour ramp: transparent → amber → red → magenta. Starts at 0.5 °C so
# agreement renders as nothing at all.
RAMP = [(0.5, (0, 0, 0, 0)), (1.0, (217, 197, 74, 90)), (2.0, (224, 151, 61, 150)),
        (4.0, (217, 64, 64, 200)), (8.0, (200, 60, 180, 235))]


def fetch(url: str, rng: tuple[int, int] | None = None) -> bytes:
    last: Exception | None = None
    for attempt, delay in enumerate([0, *RETRY_S]):
        if delay:
            time.sleep(delay)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            if rng:
                req.add_header("Range", f"bytes={rng[0]}-{rng[1]}")
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 — the 429s are the documented reality here
            last = e
            print(f"  attempt {attempt + 1}: {e}", file=sys.stderr)
    raise RuntimeError(f"fetch failed after retries: {last}")


def candidate_cycles():
    now = datetime.now(timezone.utc)
    t = now - timedelta(hours=8)  # open-data publication lag
    t = t.replace(hour=(t.hour // 6) * 6, minute=0, second=0, microsecond=0)
    for i in range(4):
        c = t - timedelta(hours=6 * i)
        yield c.strftime("%Y%m%d"), f"{c.hour:02d}"


def field_2t(model: str, date: str, hh: str, step: int) -> np.ndarray:
    stem = f"{BASE}/{date}/{hh}z/{model}/0p25/oper/{date}{hh}0000-{step}h-oper-fc"
    idx = fetch(f"{stem}.index").decode("utf-8", "replace")
    entry = None
    for line in idx.splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("param") == "2t":
            entry = e
            break
    if not entry:
        raise RuntimeError(f"no 2t in {model} step {step}")
    off, ln = int(entry["_offset"]), int(entry["_length"])
    grib = fetch(f"{stem}.grib2", (off, off + ln - 1))

    h = eccodes.codes_new_from_message(grib)
    try:
        ni = eccodes.codes_get(h, "Ni")
        nj = eccodes.codes_get(h, "Nj")
        vals = eccodes.codes_get_values(h).reshape(nj, ni)
    finally:
        eccodes.codes_release(h)
    return vals  # Kelvin, 721×1440, lat 90..-90, lon 0..359.75


def colorize(diff: np.ndarray) -> np.ndarray:
    rgba = np.zeros((*diff.shape, 4), dtype=np.uint8)
    for i in range(len(RAMP)):
        lo_v, lo_c = RAMP[i]
        hi_v, hi_c = RAMP[i + 1] if i + 1 < len(RAMP) else (np.inf, RAMP[i][1])
        mask = (diff >= lo_v) & (diff < hi_v)
        if not mask.any():
            continue
        if np.isinf(hi_v):
            for ch in range(4):
                rgba[..., ch][mask] = lo_c[ch]
        else:
            f = ((diff[mask] - lo_v) / (hi_v - lo_v)).clip(0, 1)
            for ch in range(4):
                rgba[..., ch][mask] = (lo_c[ch] + f * (hi_c[ch] - lo_c[ch])).astype(np.uint8)
    return rgba


def main() -> int:
    if not HAVE_ECCODES:
        print("eccodes unavailable (CCSDS-packed GRIB needs it) — this script runs in CI; "
              "local dev uses the committed textures.", file=sys.stderr)
        return 2

    out_dir = Path("public/data/divergence")
    for date, hh in candidate_cycles():
        try:
            print(f"trying cycle {date} {hh}z ...")
            built = []
            for step in LEADS:
                ifs = field_2t("ifs", date, hh, step)
                aifs = field_2t("aifs-single", date, hh, step)
                diff = np.abs(ifs - aifs)[::STRIDE, ::STRIDE]
                # roll lon 0..360 → −180..180 to match every other Aether texture
                diff = np.roll(diff, diff.shape[1] // 2, axis=1)
                rgba = colorize(diff)

                out_dir.mkdir(parents=True, exist_ok=True)
                png = out_dir / f"t2m-{step}h.png"
                Image.fromarray(rgba, "RGBA").save(png, optimize=True)
                built.append({
                    "lead": step,
                    "file": png.name,
                    "maxDiffC": round(float(diff.max()), 1),
                    "meanDiffC": round(float(diff.mean()), 2),
                    "pctOver2C": round(float((diff > 2).mean() * 100), 1),
                })
                print(f"  {step}h: max {diff.max():.1f} C, mean {diff.mean():.2f} C, "
                      f"{(diff > 2).mean() * 100:.1f}% of globe >2 C")

            (out_dir / "index.json").write_text(json.dumps({
                "cycle": f"{date}T{hh}00Z",
                "variable": "|IFS − AIFS| 2 m temperature",
                "units": "°C",
                "leads": built,
                "bounds": [-180, -90, 180, 90],
                "ramp": [[v, list(c)] for v, c in RAMP],
                "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "attribution": "This service is based on data and products of ECMWF. "
                               "© 2026 ECMWF (CC BY 4.0). Field derived: |IFS − AIFS| at 2 m.",
            }, indent=1), encoding="utf-8")
            print(f"wrote {out_dir}/index.json + {len(built)} textures")
            return 0
        except Exception as e:  # noqa: BLE001
            print(f"  cycle {date}{hh} failed: {e} — walking back", file=sys.stderr)
    print("no publishable cycle found", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
