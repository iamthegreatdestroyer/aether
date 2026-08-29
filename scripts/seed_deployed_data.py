#!/usr/bin/env python3
"""Seed public/data from the live site before the builders run.

WHY THIS EXISTS
Each data builder ends with `|| echo "::warning:: ... deploying
last-known-good"`. That phrase was only ever half true: the fallback was
whatever is COMMITTED in the repo, not what is actually deployed. The
committed snapshots are a dev convenience and go stale by design, so a
single failed fetch republished them over fresher live data.

Measured 2026-08-29: FIRMS could not be reached from the runner, the fire
build fell back, and the live smoke snapshot jumped BACKWARDS from 08-27
to 08-18 — eleven days lost to one transient failure, on a panel that
prints its own build date to the reader.

Running this first makes the phrase true: the working tree starts from
what is live, so a builder that fails degrades to the last SUCCESSFUL
BUILD rather than to whatever was last hand-committed.

HOW IT DECIDES
Every data file carries its own build time (`builtAt`, or `generated` for
the storm ledger), so freshness is compared on the data's own terms rather
than on file mtimes, which checkout destroys. A file is replaced only when
the deployed copy is genuinely newer. That keeps a deliberate hand-commit
of corrected data authoritative — it is newer, so it wins.

Failure is never fatal: no network, a 404, malformed JSON, a missing
timestamp — all leave the committed file in place and the build continues.
That is the same degrade-don't-block rule the builders follow.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE_URL = os.environ.get(
    "AETHER_DEPLOYED_URL", "https://iamthegreatdestroyer.github.io/aether"
).rstrip("/")
PUBLIC = Path(__file__).resolve().parent.parent / "public"
TIMEOUT_S = 60
UA = "Aether/0.1 seed-deployed-data (personal weather app)"

# An "anchor" is the JSON that carries the timestamp; its assets are the
# binaries that are only meaningful alongside that exact JSON, so they move
# together or not at all. A texture from one cycle beside an index from
# another would render a quietly wrong map.
GROUPS: list[dict] = [
    {"anchor": "data/wind/latest.json", "assets": ["data/wind/latest.png"]},
    {"anchor": "data/wind/250.json", "assets": ["data/wind/250.png"]},
    {"anchor": "data/wind/500.json", "assets": ["data/wind/500.png"]},
    {"anchor": "data/wind/850.json", "assets": ["data/wind/850.png"]},
    {"anchor": "data/fires/latest.json", "assets": []},
    {"anchor": "data/storms/ledger.json", "assets": []},
    {"anchor": "data/marine/stations.json", "assets": []},
    {"anchor": "data/marine/buoys.json", "assets": []},
    # Divergence textures are named by the index itself; resolved at runtime.
    {"anchor": "data/divergence/index.json", "assets": "@from-index"},
]

TIME_KEYS = ("builtAt", "generated")


def built_at(doc: object) -> datetime | None:
    """The document's own build time, or None if it does not state one."""
    if not isinstance(doc, dict):
        return None
    for key in TIME_KEYS:
        raw = doc.get(key)
        if not isinstance(raw, str):
            continue
        try:
            stamp = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
        return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)
    return None


def get(path: str) -> bytes | None:
    req = urllib.request.Request(f"{BASE_URL}/{path}", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            return r.read()
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        print(f"  {path}: not fetched ({e})")
        return None


def divergence_assets(doc: object) -> list[str]:
    if not isinstance(doc, dict):
        return []
    return [
        f"data/divergence/{lead['file']}"
        for lead in doc.get("leads", [])
        if isinstance(lead, dict) and isinstance(lead.get("file"), str)
    ]


def write(path: str, payload: bytes) -> None:
    """Replace via a temp file so an interrupted write cannot leave a
    truncated data file behind — the committed copy stays valid until the
    new one is complete."""
    target = PUBLIC / path
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".part")
    tmp.write_bytes(payload)
    tmp.replace(target)


def seed_group(group: dict) -> str:
    anchor = group["anchor"]
    raw = get(anchor)
    if raw is None:
        return "skipped"

    try:
        deployed = json.loads(raw)
    except ValueError:
        print(f"  {anchor}: deployed copy is not valid JSON — keeping committed")
        return "skipped"

    deployed_at = built_at(deployed)
    if deployed_at is None:
        print(f"  {anchor}: deployed copy states no build time — keeping committed")
        return "skipped"

    local_path = PUBLIC / anchor
    local_at = None
    if local_path.exists():
        try:
            local_at = built_at(json.loads(local_path.read_text(encoding="utf-8")))
        except (ValueError, OSError):
            local_at = None

    if local_at is not None and local_at >= deployed_at:
        print(f"  {anchor}: committed copy is current ({local_at:%Y-%m-%d %H:%MZ})")
        return "current"

    assets = group["assets"]
    if assets == "@from-index":
        assets = divergence_assets(deployed)

    # Fetch the companions BEFORE replacing the anchor: a half-applied group
    # is worse than an old but coherent one.
    fetched: list[tuple[str, bytes]] = []
    for asset in assets:
        payload = get(asset)
        if payload is None:
            print(f"  {anchor}: companion {asset} missing — keeping committed group")
            return "skipped"
        fetched.append((asset, payload))

    write(anchor, raw)
    for asset, payload in fetched:
        write(asset, payload)

    was = f"{local_at:%Y-%m-%d %H:%MZ}" if local_at else "absent"
    print(
        f"  {anchor}: seeded {deployed_at:%Y-%m-%d %H:%MZ} "
        f"(committed was {was}){f' +{len(fetched)} asset(s)' if fetched else ''}"
    )
    return "seeded"


def main() -> int:
    if os.environ.get("AETHER_SKIP_SEED"):
        print("seed skipped (AETHER_SKIP_SEED set)")
        return 0

    print(f"Seeding public/data from {BASE_URL}")
    tally = {"seeded": 0, "current": 0, "skipped": 0}
    for group in GROUPS:
        try:
            tally[seed_group(group)] += 1
        except Exception as e:  # noqa: BLE001 — seeding must never break a deploy
            print(f"  {group['anchor']}: unexpected {type(e).__name__}: {e}")
            tally["skipped"] += 1

    print(
        f"{tally['seeded']} seeded from the live site, "
        f"{tally['current']} already current, {tally['skipped']} left as committed."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
