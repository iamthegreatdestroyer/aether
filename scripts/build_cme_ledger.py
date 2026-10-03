#!/usr/bin/env python3
"""
The CME ledger — "how right has NASA's Enlil been about when a CME arrives?"

The Space panel shows the CME watch (WSA-Enlil's predicted shock arrival and Kp range). Like
every consumer space-weather surface it never says how those predictions have fared. DONKI
publishes both halves of the answer:

  - WSAEnlilSimulations ... every model run: Earth-directed flag, predicted shock arrival,
                            Kp ranges, and the CME(s) that fed the run (cmeInputs[].CMEID)
  - IPS (location=Earth) .. observed interplanetary shocks; `linkedEvents` carries the CME
                            activityID that a forecaster tied each shock to, and any storm (GST)
  - GST ................... observed geomagnetic storms with their Kp readings

SCORING RULE — read before changing it
A prediction is scored per CME, using that CME's LAST Enlil run (the forecast closest to
arrival, which is the one a reader would have acted on). It counts as CONFIRMED only when a
forecaster-linked IPS exists for that CME. We deliberately do NOT match by time proximity:
measured 2026-10-03, Earth sees ~73 shocks a year (one per ~5 days), so a +-24 h window
"confirms" about half of all predictions by pure coincidence. The linked match is the
discriminating one — and its limit is stated in the output: "no confirmed arrival" is NOT
"false alarm", it means no forecaster-linked shock (glancing blows and unlinked shocks both
land here).

Predictions are only scored once they are MATURE (predicted arrival + 36 h has passed);
younger ones are listed as pending. Storm intensity is compared as the highest Kp of the
linked storm vs the model's Kp range; the model's range is known to run low, and with
single-digit samples the summary says so instead of pretending to a rate.

NASA CCMC DONKI: US Government work, public domain, keyless, CORS-open. Same Tier B pattern as
the storm ledger: fetched by CI, shipped same-origin, last-known-good on failure.
"""

from __future__ import annotations

import json
import statistics
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

BASE = "https://ccmc.gsfc.nasa.gov/DONKI-API/get"
UA = "Aether/0.1 (personal weather app; contact: sgbilod@gmail.com)"
OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "space" / "cme_ledger.json"
HISTORY_DAYS = 365
WINDOW_DAYS = 59  # DONKI refuses queries wider than 60 days
MATURE_AFTER_H = 36
RECENT_KEEP = 12  # individual rows shipped for the panel; the summary covers all of them
MIN_SAMPLE = 10  # below this the panel must say "too few to trust" rather than quote a rate


def get(path: str):
    req = urllib.request.Request(f"{BASE}/{path}", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        body = json.load(r)
    # DONKI answers an empty window with `null`/[] — normalise so callers can iterate.
    return body or []


def ts(raw: str) -> datetime:
    return datetime.strptime(raw, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)


def iso(d: datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%MZ")


def fetch_all(path: str, end: date, days: int, extra: str = "") -> list[dict]:
    out: list[dict] = []
    start = end - timedelta(days=days)
    while start < end:
        stop = min(start + timedelta(days=WINDOW_DAYS), end)
        out += get(f"{path}?startDate={start}&endDate={stop}{extra}")
        start = stop + timedelta(days=1)
    return out


def dedupe(rows: list[dict], key: str) -> list[dict]:
    return list({r[key]: r for r in rows if r.get(key)}.values())


def pct(n: int, d: int) -> int | None:
    return round(100 * n / d) if d else None


def build(now: datetime) -> dict:
    end = now.date()
    enlil = dedupe(fetch_all("WSAEnlilSimulations", end, HISTORY_DAYS), "simulationID")
    ips = dedupe(fetch_all("IPS", end, HISTORY_DAYS, "&location=Earth&catalog=ALL"), "activityID")
    gst = dedupe(fetch_all("GST", end, HISTORY_DAYS), "gstID")
    if not enlil:
        raise RuntimeError("DONKI returned no Enlil runs at all — refusing to publish an empty ledger")

    gst_kp = {
        g["gstID"]: max((k["kpIndex"] for k in (g.get("allKpIndex") or [])), default=None)
        for g in gst
    }
    ips_by_cme: dict[str, list[dict]] = {}
    for i in ips:
        for link in i.get("linkedEvents") or []:
            if "-CME-" in link.get("activityID", ""):
                ips_by_cme.setdefault(link["activityID"], []).append(i)

    # Final (latest) Earth-directed run per CME.
    final: dict[str, dict] = {}
    runs_per_cme: dict[str, int] = {}
    for x in enlil:
        if not (x.get("isEarthGB") and x.get("estimatedShockArrivalTime")):
            continue
        for c in x.get("cmeInputs") or []:
            cid = c.get("CMEID")
            if not cid:
                continue
            runs_per_cme[cid] = runs_per_cme.get(cid, 0) + 1
            if cid not in final or x["modelCompletionTime"] > final[cid]["modelCompletionTime"]:
                final[cid] = x

    rows: list[dict] = []
    for cid, x in final.items():
        pred = ts(x["estimatedShockArrivalTime"])
        issued = ts(x["modelCompletionTime"])
        kps = [x.get(k) for k in ("kp_18", "kp_90", "kp_135", "kp_180") if x.get(k) is not None]
        row: dict = {
            "cme": cid,
            "issued": iso(issued),
            "predicted": iso(pred),
            "kpLow": min(kps) if kps else None,
            "kpHigh": max(kps) if kps else None,
            "runs": runs_per_cme[cid],
        }
        if pred + timedelta(hours=MATURE_AFTER_H) > now:
            row["status"] = "pending"
        else:
            linked = ips_by_cme.get(cid)
            if linked:
                # If a CME has several linked shocks, the one nearest the prediction is the
                # arrival the forecast was about.
                best = min(linked, key=lambda i: abs((ts(i["eventTime"]) - pred).total_seconds()))
                obs = ts(best["eventTime"])
                storm = [
                    gst_kp[l["activityID"]]
                    for l in (best.get("linkedEvents") or [])
                    if l.get("activityID") in gst_kp and gst_kp[l["activityID"]] is not None
                ]
                row.update(
                    status="confirmed",
                    observed=iso(obs),
                    errorH=round((obs - pred).total_seconds() / 3600, 1),  # + = arrived LATER
                    observedKp=max(storm) if storm else None,
                )
            else:
                row["status"] = "unconfirmed"
        rows.append(row)
    rows.sort(key=lambda r: r["predicted"], reverse=True)

    scored = [r for r in rows if r["status"] in ("confirmed", "unconfirmed")]
    confirmed = [r for r in rows if r["status"] == "confirmed"]
    errs = [r["errorH"] for r in confirmed]
    kp_pairs = [r for r in confirmed if r.get("observedKp") is not None and r["kpHigh"] is not None]
    under = [r for r in kp_pairs if r["observedKp"] > r["kpHigh"]]

    summary = {
        "predictions": len(rows),
        "scored": len(scored),
        "pending": sum(1 for r in rows if r["status"] == "pending"),
        "confirmed": len(confirmed),
        "unconfirmed": len(scored) - len(confirmed),
        "confirmedPct": pct(len(confirmed), len(scored)),
        "arrival": {
            "n": len(errs),
            "medianErrorH": round(statistics.median(errs), 1) if errs else None,
            "meanAbsErrorH": round(statistics.mean(abs(e) for e in errs), 1) if errs else None,
            "within6hPct": pct(sum(1 for e in errs if abs(e) <= 6), len(errs)),
            "within12hPct": pct(sum(1 for e in errs if abs(e) <= 12), len(errs)),
        },
        "kp": {
            "n": len(kp_pairs),
            "stormExceededRange": len(under),
        },
        "enough": len(confirmed) >= MIN_SAMPLE,
        "caveat": (
            "Confirmed = a forecaster linked an observed Earth shock to that CME. Unconfirmed "
            "means no such link, not necessarily a false alarm (glancing blows and unlinked "
            "shocks land here). Each CME is scored on its latest Enlil run."
        ),
    }
    return {
        "builtAt": iso(now),
        "source": "NASA CCMC DONKI (WSAEnlilSimulations, IPS, GST)",
        "historyDays": HISTORY_DAYS,
        "summary": summary,
        "recent": rows[:RECENT_KEEP],
    }


def main() -> int:
    now = datetime.now(timezone.utc)
    try:
        doc = build(now)
    except Exception as e:  # noqa: BLE001 — caller degrades to last-known-good
        print(f"cme ledger failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".json.part")
    tmp.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    tmp.replace(OUT)
    s = doc["summary"]
    print(
        f"cme ledger: {s['predictions']} predictions ({s['scored']} scored, {s['pending']} pending), "
        f"{s['confirmed']} confirmed, MAE {s['arrival']['meanAbsErrorH']} h, "
        f"{OUT.stat().st_size} bytes"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
