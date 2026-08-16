# Gate G0.4 — particle-engine spike

**Throwaway. Measure, decide, record the decision in an ADR, delete.**

## Why this gate exists

The proposal names `@astrosat/windgl` as the particle engine for P1 — the critical path and
its own self-declared hardest phase. That package was published **2019-04-03**, last modified
**2022-04-04**, and declares `peerDependencies: {mapbox-gl: ^0.53.1}`. It will not drop into
MapLibre 5 or 6.

So P1 has no proven foundation, and finding that out *during* P1 would cost a month. This
harness exists to find out in a weekend instead.

## Run it

```bash
volta run --node 20.20.1 -- pnpm -C aether/spike dev
```

Then open <http://localhost:5174>. The dev server binds all interfaces, so the second half of
the exit test — your actual phone — is `http://<this-machine-lan-ip>:5174`.

To rebuild the wind fixture from a fresh GFS cycle:

```bash
python tools/build_fixture.py
```

## The exit test

**Pass** = 60 fps at 1,000,000 particles on the laptop, p95 frame time ≤ 20 ms, **and** usable
(≥ 30 fps) on your phone. The HUD computes this verdict for you and colours it.

Also watch **basemap repaints**. Hold the camera still: it must drop to zero while particle
fps stays high. If it tracks the particle rate, the two-canvas split is not working and you
are repainting the entire map every frame — the exact failure the pattern exists to prevent.

If no candidate clears the bar in a weekend, **stop and re-plan P1.** Do not let it bleed into
the build.

## Candidates

Edit the `ENGINES` array in `src/main.ts`. Each candidate wraps to the five-method interface in
`src/engines/types.ts`; if a library can't be wrapped that thinly, that *is* a finding about
integration cost and belongs in the write-up.

| Candidate | Version | License | Note |
|---|---|---|---|
| **Baseline** (included) | — | MIT lineage, zero deps | The `cambecc/earth` algorithm written from scratch. Both the control and the evaluation of the "just port it" option. |
| `maplibre-gl-wind` | 0.2.1, modified 2026-08-15 | MIT | Purpose-built for MapLibre, actively developed. **Try first.** |
| `weatherlayers-gl` | 2026.5.2 | MPL-2.0 **OR** custom terms | Mature. Read the dual-license — the alternate term exists for a reason. |
| `deck.gl` overlay | 9.3.10 | MIT | Fallback if custom-layer integration fights you. |

## The fixture

Real NOAA/NCEP GFS 0.25° 10 m wind, `20260816T1200Z` f000, decimated to 360×181, encoded
R=u / G=v with the scaling in `public/wind.json`. 101,629 bytes — the proposal predicted
"~80 KB for a 360×180 grid", so that estimate holds.

**Getting it took more work than planned, and the reason is worth recording:** the intended
route was NOMADS OPeNDAP, which serves plain-text arrays and needs no GRIB decoding at all.
**OPeNDAP has been retired** (NWS SCN25-81 — `nomads.ncep.noaa.gov/dods` now returns a notice
page). The NOMADS *filter CGI* still works but returns GRIB2, and this machine has no
`wgrib2`/`ecCodes`, with no `eccodes` binary wheel for Python 3.14. So
`tools/build_fixture.py` implements **GRIB2 Data Representation Template 5.3** — complex
packing with spatial differencing — in pure Python + numpy.

That decoder is **validated against an independent source**, not assumed correct. Sampling the
decoded grid at six locations and comparing to Open-Meteo's own GFS for the same hour:

| location | decoded | Open-Meteo | Δspeed | Δdir |
|---|---|---|---|---|
| N Atlantic | 11.8 m/s @ 191° | 11.8 @ 191° | +0.0 | 0° |
| Southern Ocean | 9.9 @ 289° | 9.9 @ 290° | +0.0 | −1° |
| Equator Pacific | 7.8 @ 107° | 7.8 @ 106° | −0.1 | +1° |
| Sahara | 6.2 @ 37° | 5.7 @ 35° | +0.4 | +2° |
| Bay of Bengal | 10.6 @ 227° | 10.8 @ 227° | −0.2 | 0° |
| Kansas | 3.4 @ 38° | 1.7 @ 17° | +1.7 | +21° |

Five of six agree to a few tenths of a m/s. Kansas is 1° decimation of a 0.25° grid over a
1.7 m/s wind, where direction is inherently unstable — the expected artefact, not a decode
error. A wrong decode produces garbage, not near-exact agreement at five sites.

## What has and has not been verified

**Verified here:**

- The full pipeline runs: GRIB2 → PNG → GL texture → update shader → draw shader → trail
  compositing. Stepped 300 frames headlessly with no GL error and no context loss.
- Particle count is honoured: requesting 2k/20k/200k/1M yields 2,025 / 20,164 / 200,704 /
  1,000,000 — perfect squares, as the texture-backed design implies.
- Screen coverage scales monotonically with particle count (1.1% → 9.9% → 54.3% → 94.1%),
  sub-linearly at the top from overlap. This is what proves particles are genuinely being
  advected and drawn rather than the canvas being filled by a bug.
- Production build succeeds; `tsc --noEmit` is clean.

**NOT verified — and it is the whole point of the gate:**

- **No frame rate has been measured.** `requestAnimationFrame` is suspended whenever the tab
  is not compositing, and GL command submission is asynchronous, so the headless harness
  reported an absurd 31,578 fps. That number is an artefact, not a result. **Only a human with
  the window visible can settle this gate.**
- Nothing on a phone.
- No candidate library has been evaluated yet — only the baseline exists.

## Two bugs this harness caught in its own first run

Recorded because both would have been blamed on a candidate library later:

1. **`crypto.getRandomValues()` throws above 65,536 bytes per call.** Seeding 1M particles
   needs a 4 MB buffer. Fill it in chunks.
2. **Passing a mutable params object by reference defeats every change check.** The engine
   held the same object the UI mutates, so `params.particleCount !== this.params.particleCount`
   compared a value with itself and the particle-count slider silently did nothing. The engine
   now copies. Caught only because the coverage sweep reported `actual: 1000000` for every
   requested count.

## Layout

```
tools/build_fixture.py     GRIB2 5.3 decoder + PNG encoder (validated above)
public/wind.png|json       the fixture and its scaling metadata
src/main.ts                two-canvas wiring, camera, controls, __spike debug hook
src/hud.ts                 fps / p95 / two-canvas proof / verdict
src/engines/types.ts       the five-method contract every candidate must meet
src/engines/baseline.ts    control implementation, WebGL2, zero deps
```

`window.__spike` exposes `step(n)`, `coverage()`, `info()`, `setCount(n)` for scripted checks.
