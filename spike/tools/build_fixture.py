#!/usr/bin/env python3
"""
Build a U/V wind data texture from real GFS GRIB2 — the fixture the particle spike renders.

WHY THIS FILE IS 300 LINES INSTEAD OF THREE
-------------------------------------------
The plan assumed `ecCodes`/`wgrib2` would decode GRIB. On this machine neither exists, and
there is no `eccodes` binary wheel for Python 3.14. The obvious fallback -- NOMADS OPeNDAP,
which serves plain-text arrays and needs no GRIB decoding at all -- has been RETIRED
(see NWS SCN25-81; https://nomads.ncep.noaa.gov/dods now returns a notice page).

What still works is the NOMADS filter CGI, which returns GRIB2. GFS packs 10 m wind with
Data Representation Template 5.3: complex packing with spatial differencing. So this file
implements that template directly. It is pure Python + numpy, no native dependencies.

Encoding produced (the convention `windgl`/`cambecc` descend from):
    R channel = u component, G = v, both linearly scaled from [min, max] to [0, 255]
    B, A unused (255)
A JSON sidecar carries the min/max so the shader can invert the scaling.

Usage:
    python tools/build_fixture.py                    # latest available GFS run
    python tools/build_fixture.py --date 20260816 --run 12
    python tools/build_fixture.py --stride 2         # 720x361 instead of 360x181

Data: NOAA/NCEP GFS via NOMADS. Public domain.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image

NOMADS = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
UA = "Aether-spike/0.1 (personal weather app; contact: sgbilod@gmail.com)"


# --------------------------------------------------------------------------- GRIB2


class BitReader:
    """Big-endian bit reader over a byte payload, vectorised for fixed-width runs."""

    def __init__(self, payload: bytes):
        self.bits = np.unpackbits(np.frombuffer(payload, dtype=np.uint8))
        self.pos = 0

    def read_many(self, width: int, count: int) -> np.ndarray:
        """Read `count` consecutive unsigned ints of `width` bits each."""
        if width == 0:
            return np.zeros(count, dtype=np.int64)
        end = self.pos + width * count
        if end > self.bits.size:
            raise ValueError(f"bit overrun: need {end}, have {self.bits.size}")
        chunk = self.bits[self.pos : end].reshape(count, width).astype(np.int64)
        weights = (1 << np.arange(width - 1, -1, -1, dtype=np.int64))
        self.pos = end
        return chunk @ weights

    def align_to_byte(self) -> None:
        self.pos = (self.pos + 7) & ~7


def _sint(raw: bytes) -> int:
    """GRIB signed integer: high bit is a sign flag, not two's complement."""
    if not raw:
        return 0
    negative = bool(raw[0] & 0x80)
    value = int.from_bytes(bytes([raw[0] & 0x7F]) + raw[1:], "big")
    return -value if negative else value


def split_messages(data: bytes):
    """Yield (discipline, body) for each GRIB2 message in the file."""
    pos = 0
    while pos < len(data) - 16:
        if data[pos : pos + 4] != b"GRIB":
            break
        total = struct.unpack(">Q", data[pos + 8 : pos + 16])[0]
        yield data[pos : pos + total]
        pos += total


def parse_message(msg: bytes) -> dict:
    """Walk sections 3/4/5/6/7 and return everything the decoder needs."""
    out: dict = {}
    p = 16
    while p < len(msg):
        if msg[p : p + 4] == b"7777":
            break
        seclen = struct.unpack(">I", msg[p : p + 4])[0]
        sec = msg[p + 4]
        body = msg[p : p + seclen]

        if sec == 3:  # grid definition
            out["ni"] = struct.unpack(">I", body[30:34])[0]
            out["nj"] = struct.unpack(">I", body[34:38])[0]
            out["lat1"] = _sint(body[46:50]) / 1e6
            out["lon1"] = _sint(body[50:54]) / 1e6
            out["lat2"] = _sint(body[55:59]) / 1e6
            out["lon2"] = _sint(body[59:63]) / 1e6
            out["scan_mode"] = body[71]
        elif sec == 4:  # product definition -- which variable is this
            out["category"] = body[9]
            out["parameter"] = body[10]
        elif sec == 5:  # data representation
            out["npoints"] = struct.unpack(">I", body[5:9])[0]
            out["drt"] = struct.unpack(">H", body[9:11])[0]
            out["R"] = struct.unpack(">f", body[11:15])[0]
            out["E"] = _sint(body[15:17])
            out["D"] = _sint(body[17:19])
            out["nbits"] = body[19]
            if out["drt"] in (2, 3):
                out["missing_mgmt"] = body[22]
                out["ngroups"] = struct.unpack(">I", body[31:35])[0]
                out["ref_width"] = body[35]
                out["nbits_width"] = body[36]
                out["ref_length"] = struct.unpack(">I", body[37:41])[0]
                out["length_inc"] = body[41]
                out["last_length"] = struct.unpack(">I", body[42:46])[0]
                out["nbits_length"] = body[46]
            if out["drt"] == 3:
                out["spatial_order"] = body[47]
                out["extra_octets"] = body[48]
        elif sec == 6:  # bitmap
            out["bitmap_indicator"] = body[5]
        elif sec == 7:  # data
            out["data"] = body[5:]
        p += seclen
    return out


def decode_complex_spatial(m: dict) -> np.ndarray:
    """
    Decode Data Representation Template 5.3 -- complex packing with spatial differencing.

    Layout of section 7 for this template:
      1. extra descriptors: ival1, [ival2 if order 2], minsd   (each `extra_octets` wide)
      2. NG group reference values           (nbits each)
      3. NG group widths                     (nbits_width each)
      4. NG group lengths (scaled)           (nbits_length each)
      5. the packed values, group by group   (that group's width, that group's length)
    """
    if m.get("bitmap_indicator", 255) != 255:
        raise NotImplementedError("bitmapped fields are not supported (GFS wind has none)")

    br = BitReader(m["data"])
    nb = m["extra_octets"]
    order = m["spatial_order"]

    # 1. extra descriptors -- the seed values for undifferencing
    ival1 = br.read_many(nb * 8, 1)[0]
    ival2 = br.read_many(nb * 8, 1)[0] if order == 2 else 0
    raw_minsd = br.read_many(nb * 8, 1)[0]
    # minsd uses the same sign-flag convention as other GRIB signed ints
    sign_bit = 1 << (nb * 8 - 1)
    minsd = -(int(raw_minsd) & ~sign_bit) if raw_minsd & sign_bit else int(raw_minsd)

    ng = m["ngroups"]

    # 2/3/4. group metadata -- each list is byte-aligned after it
    refs = br.read_many(m["nbits"], ng)
    br.align_to_byte()
    widths = br.read_many(m["nbits_width"], ng) + m["ref_width"]
    br.align_to_byte()
    lengths = br.read_many(m["nbits_length"], ng) * m["length_inc"] + m["ref_length"]
    br.align_to_byte()
    lengths[-1] = m["last_length"]

    # 5. the values themselves
    values = np.empty(int(lengths.sum()), dtype=np.int64)
    at = 0
    for g in range(ng):
        n, w = int(lengths[g]), int(widths[g])
        if n == 0:
            continue
        # width 0 means every value in the group equals the group reference
        values[at : at + n] = refs[g] if w == 0 else br.read_many(w, n) + refs[g]
        at += n
    values = values[:at]

    # undo spatial differencing
    if order == 1:
        values[1:] += minsd
        values[0] = ival1
        values = np.cumsum(values)
    elif order == 2:
        values[2:] += minsd
        values[0], values[1] = ival1, ival2
        # second-order recurrence: v[i] += 2*v[i-1] - v[i-2]. Sequential by nature.
        for i in range(2, values.size):
            values[i] += 2 * values[i - 1] - values[i - 2]
    else:
        raise NotImplementedError(f"spatial differencing order {order}")

    # scale back to physical units
    return (m["R"] + values.astype(np.float64) * (2.0 ** m["E"])) / (10.0 ** m["D"])


def field_to_grid(m: dict) -> np.ndarray:
    """Decode one message and orient it as [lat][lon], north-to-south."""
    if m["drt"] != 3:
        raise NotImplementedError(f"data representation template {m['drt']}")
    values = decode_complex_spatial(m)
    grid = values[: m["ni"] * m["nj"]].reshape(m["nj"], m["ni"])
    # scan mode bit 2 (0x40) set means south-to-north; GFS is north-to-south (unset)
    if m["scan_mode"] & 0x40:
        grid = grid[::-1, :]
    return grid


# ----------------------------------------------------------------------- pipeline


def latest_run(now: datetime | None = None) -> tuple[str, str]:
    """Most recent GFS cycle likely to be published (runs 00/06/12/18Z, ~4-5 h lag)."""
    now = now or datetime.now(timezone.utc)
    t = now - timedelta(hours=5)
    return t.strftime("%Y%m%d"), f"{(t.hour // 6) * 6:02d}"


def fetch_grib(date: str, run: str) -> bytes:
    url = (
        f"{NOMADS}?file=gfs.t{run}z.pgrb2.0p25.f000"
        f"&lev_10_m_above_ground=on&var_UGRD=on&var_VGRD=on"
        f"&dir=%2Fgfs.{date}%2F{run}%2Fatmos"
    )
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--date", help="YYYYMMDD (default: latest published run)")
    ap.add_argument("--run", help="00|06|12|18")
    ap.add_argument("--stride", type=int, default=4, help="grid decimation (4 -> 360x181)")
    ap.add_argument("--out", default="public/wind.png")
    args = ap.parse_args()

    date, run = (args.date, args.run) if args.date and args.run else latest_run()
    print(f"GFS {date} {run}Z f000, 10 m wind")

    raw = fetch_grib(date, run)
    print(f"  fetched {len(raw):,} bytes of GRIB2")
    if not raw.startswith(b"GRIB"):
        print("  ERROR: not GRIB2 -- run probably not published yet", file=sys.stderr)
        return 1

    fields: dict[str, np.ndarray] = {}
    meta: dict = {}
    for msg in split_messages(raw):
        m = parse_message(msg)
        name = {(2, 2): "u", (2, 3): "v"}.get((m["category"], m["parameter"]))
        if not name:
            continue
        fields[name] = field_to_grid(m)
        meta = m
        print(f"  decoded {name.upper()}GRD  {m['nj']}x{m['ni']}  template 5.{m['drt']}")

    if "u" not in fields or "v" not in fields:
        print("  ERROR: missing UGRD or VGRD", file=sys.stderr)
        return 1

    s = args.stride
    u, v = fields["u"][::s, ::s], fields["v"][::s, ::s]

    # GFS longitudes run 0..359.75. Roll to -180..180 so the texture maps directly to
    # Web Mercator x without the shader having to special-case the antimeridian.
    half = u.shape[1] // 2
    u, v = np.roll(u, half, axis=1), np.roll(v, half, axis=1)

    speed = np.hypot(u, v)

    # ONE SHARED SYMMETRIC RANGE FOR BOTH CHANNELS -- and the reason matters.
    #
    # The windgl/cambecc convention stores an independent [min,max] per channel, which packs
    # the most precision into 8 bits. The deck.gl/weatherlayers convention (`imageUnscale`)
    # is a SINGLE [min,max] pair applied to both channels, so an asymmetric per-channel
    # encoding silently skews v against u there.
    #
    # A fixture that decodes differently in two engines makes the comparison meaningless, so
    # this uses one symmetric range that is exactly correct under both readings. It costs
    # roughly half a bit of precision per channel and buys a fair benchmark.
    extent = float(max(abs(u).max(), abs(v).max()))
    u_min = v_min = -extent
    u_max = v_max = extent

    rgba = np.zeros((u.shape[0], u.shape[1], 4), dtype=np.uint8)
    rgba[..., 0] = np.round((u - u_min) / (u_max - u_min) * 255).astype(np.uint8)
    rgba[..., 1] = np.round((v - v_min) / (v_max - v_min) * 255).astype(np.uint8)
    rgba[..., 3] = 255

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(out, optimize=True)

    sidecar = {
        "source": "NOAA/NCEP GFS 0.25deg via NOMADS filter CGI",
        "license": "public domain",
        "cycle": f"{date}T{run}00Z",
        "forecastHour": 0,
        "variable": "10 m wind",
        "width": int(u.shape[1]),
        "height": int(u.shape[0]),
        "uMin": u_min, "uMax": u_max,
        "vMin": v_min, "vMax": v_max,
        # deck.gl / weatherlayers convention: one [min,max] for both channels. Identical to
        # the per-channel values above by construction, so both engines decode the same field.
        "imageUnscale": [u_min, u_max],
        # [west, south, east, north] -- deck.gl layer `bounds` prop
        "bounds": [-180, -90, 180, 90],
        "maxSpeedMs": float(speed.max()),
        "meanSpeedMs": float(speed.mean()),
        "lonRange": [-180, 180],
        "latRange": [90, -90],
        "encoding": "R = (u - uMin) / (uMax - uMin), G = (v - vMin) / (vMax - vMin)",
        "decodedBy": "spike/tools/build_fixture.py (pure-python GRIB2 template 5.3)",
    }
    out.with_suffix(".json").write_text(json.dumps(sidecar, indent=2), encoding="utf-8")

    print(f"\n  wrote {out}  ({out.stat().st_size:,} bytes, {u.shape[1]}x{u.shape[0]})")
    print(f"  wrote {out.with_suffix('.json')}")
    print(f"  u {u_min:+.1f}..{u_max:+.1f} m/s   v {v_min:+.1f}..{v_max:+.1f} m/s")
    print(f"  speed mean {speed.mean():.1f}  max {speed.max():.1f} m/s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
