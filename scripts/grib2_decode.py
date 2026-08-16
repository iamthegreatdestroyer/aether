"""
GRIB2 decoder — Data Representation Template 5.3 (complex packing + spatial differencing).

Pure Python + numpy, zero native dependencies. Written for the P1 spike when it turned out
this machine had no wgrib2/ecCodes and PyPI had no eccodes wheel for Python 3.14 — and kept
because a decoder with no binary dependency is exactly what a GitHub Actions cron wants: no
apt-get, no conda, nothing to break on a runner image update.

VALIDATED, not assumed: decoded GFS 10 m wind sampled at six sites against Open-Meteo's own
GFS for the same hour agreed within 0.4 m/s and 2 degrees at five of six; the sixth was
1-degree decimation over a 1.7 m/s wind, where direction is inherently unstable
(spike/README.md has the full table).

Scope, honestly stated: template 5.3 only, no bitmapped fields, regular lat/lon grids
(template 3.0). GFS pgrb2 files fit; CCSDS-packed products (DWD ICON post-2026-06, some
ECMWF) do NOT — those need real ecCodes, which is the documented Tier B upgrade path.
"""

from __future__ import annotations

import struct

import numpy as np

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
