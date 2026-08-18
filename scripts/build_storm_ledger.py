#!/usr/bin/env python3
"""
The storm ledger — "which model has been closest for THIS storm, so far."

Born from the live Windy recon (plan §9.2-B): their hurricane tracker draws the observed
track and the forecast cone on the same canvas and never diffs them, and its model chips can
only be viewed one at a time. Yet NHC/CPHC publish everything needed to score the models
against reality WHILE THE STORM IS STILL ACTIVE:

  - CurrentStorms.json ......... which storms exist right now
  - atcf/btk/b{id}.dat ......... best track: the observed truth, 6-hourly
  - atcf/aid_public/a{id}.dat.gz  every model's forecast track from every cycle

For each model forecast point (cycle C, lead τ), the verifying truth is the best-track entry
at C+τ. Great-circle distance = track error; |Vmax difference| = intensity error. Aggregate
by model × lead, and the answer to "who has been right about Lala" exists before landfall —
which is when it matters. ForecastWatch verifies post-hoc and B2B; consumer apps show tracks
without scores; this closes that gap at personal scale.

Scoring set: the EARLY (interpolated) aids plus OFCL, because that is the apples-to-apples
comparison NHC's own verification uses — raw model cycles arrive hours after advisory time.
**ECMWF does not appear in NOAA's public a-decks** (its track data is licensed); the output
says so explicitly rather than quietly scoring a diminished field.

All NOAA products: US Government work, public domain. Same Tier B pattern as the wind
texture: fetched by CI, shipped same-origin, committed snapshot as last-known-good.
"""

from __future__ import annotations

import gzip
import io
import json
import math
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

NHC = "https://www.nhc.noaa.gov/CurrentStorms.json"
BTK = "https://ftp.nhc.noaa.gov/atcf/btk/b{sid}.dat"
ADECK = "https://ftp.nhc.noaa.gov/atcf/aid_public/a{sid}.dat.gz"
UA = "Aether/0.1 (personal weather app; contact: sgbilod@gmail.com)"

# Early/interpolated aids + official — NHC's own verification convention.
TECHS = {
    "OFCL": "Official (NHC/CPHC)",
    "AVNI": "GFS (early)",
    "UKXI": "UKMET (early)",
    "TVCN": "Consensus",
    "HFAI": "HAFS-A (early)",
    "HFBI": "HAFS-B (early)",
    "CMCI": "CMC (early)",
}
LEADS = [12, 24, 36, 48, 72, 96, 120]


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()


def parse_latlon(lat: str, lon: str) -> tuple[float, float]:
    la = int(lat[:-1]) / 10.0 * (1 if lat.endswith("N") else -1)
    lo = int(lon[:-1]) / 10.0 * (1 if lon.endswith("E") else -1)
    return la, lo


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6371.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = math.radians(b[0] - a[0]), math.radians(b[1] - a[1])
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(x))


def parse_deck(text: str):
    """Yield (dt, tech, tau, lat, lon, vmax). Wind-radii duplicate rows collapse via caller."""
    for ln in text.splitlines():
        f = [x.strip() for x in ln.split(",")]
        if len(f) < 9 or not f[2] or not f[6] or not f[7]:
            continue
        try:
            dt = datetime.strptime(f[2], "%Y%m%d%H").replace(tzinfo=timezone.utc)
            tau = int(f[5] or 0)
            lat, lon = parse_latlon(f[6], f[7])
            vmax = int(f[8]) if f[8] else None
        except (ValueError, IndexError):
            continue
        yield dt, f[4], tau, lat, lon, vmax


def build_storm(sid: str, name: str, meta: dict) -> dict | None:
    try:
        btk_text = fetch(BTK.format(sid=sid)).decode("utf-8", "replace")
        adeck_gz = fetch(ADECK.format(sid=sid))
        adeck_text = gzip.open(io.BytesIO(adeck_gz), "rt", errors="replace").read()
    except Exception as e:  # noqa: BLE001
        print(f"  {sid}: deck fetch failed: {e}", file=sys.stderr)
        return None

    # Truth: best track, first row per timestamp wins (radii rows repeat the fix).
    best: dict[datetime, tuple[float, float, int | None]] = {}
    for dt, tech, tau, lat, lon, vmax in parse_deck(btk_text):
        if tech == "BEST" and dt not in best:
            best[dt] = (lat, lon, vmax)

    # Forecasts: (cycle, tech, tau) → point, first row wins.
    aids: dict[tuple[datetime, str, int], tuple[float, float, int | None]] = {}
    for dt, tech, tau, lat, lon, vmax in parse_deck(adeck_text):
        if tech in TECHS and (dt, tech, tau) not in aids:
            aids[(dt, tech, tau)] = (lat, lon, vmax)

    # Score every forecast point whose verifying time has an observed fix.
    agg: dict[tuple[str, int], list[tuple[float, float | None]]] = defaultdict(list)
    for (cycle, tech, tau), (flat, flon, fvmax) in aids.items():
        if tau not in LEADS:
            continue
        truth = best.get(cycle + timedelta(hours=tau))
        if not truth:
            continue
        km = haversine_km((flat, flon), (truth[0], truth[1]))
        kt = abs(fvmax - truth[2]) if fvmax is not None and truth[2] is not None else None
        agg[(tech, tau)].append((km, kt))

    scores = []
    for tech, label in TECHS.items():
        leads = {}
        combined: list[float] = []
        for tau in LEADS:
            rows = agg.get((tech, tau), [])
            if not rows:
                continue
            kms = [r[0] for r in rows]
            kts = [r[1] for r in rows if r[1] is not None]
            leads[str(tau)] = {
                "km": round(sum(kms) / len(kms)),
                "kt": round(sum(kts) / len(kts), 1) if kts else None,
                "n": len(rows),
            }
            if tau in (24, 48, 72):
                combined.extend(kms)
        if leads:
            scores.append({
                "tech": tech,
                "label": label,
                "leads": leads,
                "overallKm": round(sum(combined) / len(combined)) if combined else None,
                "nOverall": len(combined),
            })
    scores.sort(key=lambda s: (s["overallKm"] is None, s["overallKm"] or 0))

    # Ranked sentence — the receipt, in words, with n.
    ranked = [s for s in scores if s["overallKm"] is not None and s["nOverall"] >= 3]
    sentence = None
    if len(ranked) >= 2:
        a, b = ranked[0], ranked[1]
        sentence = (
            f"Across {a['nOverall']} verified 24–72 h forecasts for {name}, "
            f"{a['label']} has been closest (avg {a['overallKm']} km off); "
            f"{b['label']} averaged {b['overallKm']} km."
        )

    # Tracks for the map: observed (all fixes) + newest official forecast.
    track = [
        {"t": dt.strftime("%Y-%m-%dT%H:%MZ"), "lat": v[0], "lon": v[1], "kt": v[2]}
        for dt, v in sorted(best.items())
    ]
    ofcl_cycles = sorted({c for (c, tech, _t) in aids if tech == "OFCL"})
    forecast = []
    if ofcl_cycles:
        newest = ofcl_cycles[-1]
        for tau in [0, *LEADS]:
            pt = aids.get((newest, "OFCL", tau))
            if pt:
                vt = newest + timedelta(hours=tau)
                forecast.append({"t": vt.strftime("%Y-%m-%dT%H:%MZ"), "tau": tau,
                                 "lat": pt[0], "lon": pt[1], "kt": pt[2]})

    return {
        "id": sid,
        "name": name,
        "classification": meta.get("classification"),
        "intensityKt": meta.get("intensity"),
        "pressureMb": meta.get("pressure"),
        "position": {"lat": meta.get("latitudeNumeric"), "lon": meta.get("longitudeNumeric")},
        "lastUpdate": meta.get("lastUpdate"),
        "bestTrack": track,
        "latestForecast": forecast,
        "scores": scores,
        "sentence": sentence,
        "advisoryCycles": len(ofcl_cycles),
    }


def main() -> int:
    out_path = Path("public/data/storms/ledger.json")
    try:
        current = json.loads(fetch(NHC))
    except Exception as e:  # noqa: BLE001
        print(f"CurrentStorms.json fetch failed: {e}", file=sys.stderr)
        return 1

    storms = []
    for s in current.get("activeStorms", []):
        sid = s.get("id", "").lower()
        if not sid:
            continue
        print(f"building ledger for {s.get('name')} ({sid}) ...")
        built = build_storm(sid, s.get("name", sid), s)
        if built:
            storms.append(built)
            print(f"  {len(built['bestTrack'])} fixes, {built['advisoryCycles']} advisories, "
                  f"{len(built['scores'])} scored models")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "NOAA NHC/CPHC ATCF (public domain)",
        "note": "ECMWF tracks are not present in NOAA's public a-decks (licensed data) — "
                "the field scored here is every public early aid plus the official forecast.",
        "storms": storms,
    }, indent=1), encoding="utf-8")
    print(f"wrote {out_path} ({out_path.stat().st_size:,} B, {len(storms)} storm(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
