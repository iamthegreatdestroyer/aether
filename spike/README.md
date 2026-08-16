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

## Results so far

Measured 2026-08-16, **AMD Radeon integrated graphics via ANGLE/D3D11**, 987×910 CSS px, dpr 1,
same GFS fixture, same camera. Integrated graphics is the realistic mid-range case, not a
flattering one.

### Baseline — zero dependencies

| particles | primitives | fps | p95 |
|---:|---:|---:|---:|
| 8,281 | 8,281 pts | 59.9 | 16.8 ms |
| 65,536 | 65,536 pts | 59.9 | 16.9 ms |
| 262,144 | 262,144 pts | 60.0 | 16.9 ms |
| **1,000,000** | 1,000,000 pts | **59.9** | **16.9 ms** |
| 2,002,225 | 2,002,225 pts | 60.0 | 17.1 ms |

**Never left vsync.** Flat 60 fps to two million particles — twice the target — with p95 under
the 20 ms bar throughout. Its actual ceiling was never found.

### `maplibre-gl-wind` 0.2.1

| particles | primitives (×50 trail) | fps | p95 |
|---:|---:|---:|---:|
| 4,096 | 204,800 | 30.0 | 33.7 ms |
| 16,384 | 819,200 | 30.0 | 33.8 ms |
| 65,536 | 3,276,800 | 31.7 | 33.0 ms |
| 131,072 | 6,553,600 | 15.9 | 64.1 ms |
| 262,144 | 13,107,200 | 7.8 | 131.3 ms |
| 1,000,000 | 50,000,000 | *renderer hung* | — |

Two distinct regimes, and conflating them would misread the library:

- **Below ~3M instances it is pinned at exactly 30 fps regardless of load** — 4k and 65k
  particles give the same 33.7 ms. That is half of 60 Hz and independent of work, so it is a
  **scheduling cadence, not saturation**. The library is not GPU-bound there; it simply does
  not present more often than every other frame.
- **Above ~3M instances it is genuinely GPU-bound** and halves cleanly per doubling
  (31.7 → 15.9 → 7.8).

### `weatherlayers-gl` 2026.5.2

| particles | primitives (×50 trail) | fps | p95 |
|---:|---:|---:|---:|
| 4,096 | 204,800 | 60.0 | 17.1 ms |
| 16,384 | 819,200 | 38.3 | 28.9 ms |
| 65,536 | 3,276,800 | 11.9 | 92.2 ms |

Reaches full 60 fps at low load — which **independently confirms** that `maplibre-gl-wind`'s
flat 30 fps is a scheduling cadence and not the GPU: same hardware, same primitive count, twice
the frame rate. But it degrades hardest of the three.

Visually it is the best of the three: long, elegant, continuous streamlines. (Configured white
here with no palette — that is this harness's choice, not a limitation.)

### Matched on primitives — the only fair axis

Deck layers draw 50 line instances per particle; the baseline draws 1 point. At equal
*primitive* counts on identical hardware and camera:

| primitives | baseline | `maplibre-gl-wind` | `weatherlayers-gl` |
|---:|---|---|---|
| 204,800 | **60.0** fps · 17.0 ms | 30.0 · 35.8 ms | **60.0** · 17.1 ms |
| 819,200 | **59.9** · 17.0 ms | 30.0 · 34.6 ms | 38.3 · 28.9 ms |
| 3,276,800 | **60.4** · 19.6 ms | 33.8 · 34.4 ms | 11.9 · 92.2 ms |
| peak throughput | **198 M prim/s** *(still vsync-capped)* | 111 M prim/s | 39 M prim/s |

Three genuinely different characters:

- **Baseline** never saturates. 60 fps at 3.28 M primitives and at 2 M *particles*; p95 only
  began creeping (19.6 ms) at the top of the range. Its ceiling was never located.
- **`maplibre-gl-wind`** is capped at ~30 fps by scheduling regardless of load, but is the more
  *efficient* deck layer by a wide margin — 111 M prim/s, barely degrading across a 16× load
  increase.
- **`weatherlayers-gl`** is uncapped and fastest-tied at light load, then falls off a cliff:
  39 M prim/s, roughly 2.8× less efficient than `maplibre-gl-wind` at the same primitive count,
  likely the cost of being a `CompositeLayer` doing LINEAR image interpolation in-shader.

### The honest comparison

Per *particle* the baseline is ~30× ahead, but that overstates it, because the two spend their
budget differently. Per *primitive* they are close:

```
baseline   2,002,225 prim x 60.0 fps = 120.1M primitives/s   (still vsync-capped — not its limit)
mgw        3,276,800 prim x 31.7 fps = 103.9M primitives/s
mgw        6,553,600 prim x 15.9 fps = 104.2M primitives/s
mgw       13,107,200 prim x  7.8 fps = 102.2M primitives/s
```

`maplibre-gl-wind` holds ~103M primitives/s across three points — textbook linear GPU-bound
scaling. So **the two engines have comparable raw throughput; the entire difference is the cost
model.** The library spends 50 primitives per particle to draw trails as real tapered geometry;
the baseline spends 1, and gets trails free from a faded framebuffer. That is a legitimate
design trade — deck.gl's trails survive camera movement without smearing, which the
framebuffer approach does not — but at 50× the cost it cannot reach the 1M-particle target on
this hardware, and it hangs the renderer trying.

Costs beyond frame rate, which matter for a PWA:

| | bundle (raw) | bundle (gzip) | `node_modules` |
|---|---:|---:|---:|
| baseline only | 1,071 kB | 290 kB | ~40 MB |
| + `maplibre-gl-wind` | 1,689 kB | 472 kB | 153 MB |
| + `weatherlayers-gl` | 1,953 kB | 563 kB | 180 MB |

**+273 kB gzipped** to carry both libraries — for a $0/month offline-first PWA that is the
whole app budget several times over.

**Provisional verdict: the baseline wins on this hardware, decisively** — on frame rate, on
bundle size, on dependency surface, and on licensing. Still owed before closing G0.4: a real
phone, and a discrete-GPU data point.

One caveat against my own result: the baseline is a *points-with-framebuffer-trails* renderer,
and both libraries draw *geometric* trails. Geometric trails survive camera movement without
smearing and look better at low particle counts — `weatherlayers-gl`'s output is the nicest of
the three. If the app ends up wanting few, long, beautiful streamlines rather than a dense
field, the ranking narrows considerably. At the 1M-particle target the baseline is the only
one that finishes.

## Candidates

Edit the `ENGINES` array in `src/main.ts`. Each candidate wraps to the interface in
`src/engines/types.ts`; if a library can't be wrapped thinly, that *is* a finding about
integration cost. `maplibre-gl-wind` needed a new `ownsSurface` flag added to the contract —
see below.

| Candidate | Version | License | Status |
|---|---|---|---|
| **Baseline** | — | MIT lineage, zero deps | ✅ 60 fps @ 2M particles · never saturated |
| **`maplibre-gl-wind`** | 0.2.1, modified 2026-08-15 | MIT | ✅ 30 fps scheduling cap · 111 M prim/s |
| **`weatherlayers-gl`** | 2026.5.2 | MPL-2.0 **OR** commercial | ✅ best-looking · 39 M prim/s · see licence below |
| `deck.gl` raw overlay | 9.3.10 | MIT | ⬜ optional; already present as a peer |

### `weatherlayers-gl` — the licence needed reading, and it matters

Declared `(MPL-2.0 OR LicenseRef-LICENSE_TERMS_OF_USE.md)`. Those two halves are not
interchangeable. From the commercial Terms, Art. 1.2:

> The User declares he/she concludes the Contract only for purposes of its **business
> activity** and he/she is not in a position of consumer. **Consumers may not conclude this
> Contract and may not use the Library** on the basis of the Terms.

Aether is a personal hobby project — squarely a consumer — so that half is *unavailable* to it,
and it carries a EUR 4,000 contractual penalty for data-warranty breaches (Art. 4.4).

**The MPL-2.0 half has no field-of-use restriction, so that is the option taken, deliberately
and on the record.** MPL-2.0 is file-level copyleft: modify weatherlayers' own files and
distribute, and those files must be published under MPL. Consuming it unmodified inside a
larger work of any licence is fine, and Aether is never conveyed. **Revisit if Aether ever
monetises** — the dual licence exists precisely to sell the other half.

Also: it depends on `@scarf/scarf` with `scarfSettings: {allowTopLevel: true}` — install-time
telemetry. For an app whose pitch is "no accounts, no ads, no tracking" that deserves a
conscious call; disable with `SCARF_ANALYTICS=false` or `scarfSettings.enabled = false` in our
own `package.json`.

One integration difference worth noting: its `image` prop takes `TextureData`
(`{data, width, height}`), **not a URL** — so the harness decodes the PNG to raw RGBA via a
canvas first. Slightly more work than `maplibre-gl-wind`'s URL prop, but strictly more control,
and it is the same shape a Tier B pipeline would hand it.

### What the name `maplibre-gl-wind` does not tell you

It is **a deck.gl layer**, not a MapLibre custom layer — `WindParticleLayer extends LineLayer`
from `@deck.gl/layers`, with no MapLibre-native implementation at all. It is integrated here
through `MapboxOverlay` with `interleaved: false`, so deck creates its own canvas above
MapLibre's and the two-canvas comparison stays fair; the HUD confirms basemap repaints stay
idle. Interleaved mode would render into MapLibre's context and repaint the whole map every
frame, which is the failure the pattern exists to prevent.

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

- **Frame rates are now real** — see Results. An earlier headless pass reported an absurd
  31,578 fps because `requestAnimationFrame` is suspended when the tab is not compositing and
  GL submission is async; those numbers were discarded. Everything in the Results table was
  read off the live HUD with the window displayed.

**NOT verified — still owed before G0.4 closes:**

- **Nothing on a phone.** The exit test has two halves and only one is done. The dev server
  binds all interfaces for this; use `http://<lan-ip>:5174`.
- **Only one hardware profile.** Integrated AMD Radeon. A discrete GPU may reorder the result,
  though a 30× particle gap is unlikely to invert.
- **`weatherlayers-gl` not evaluated.**
- Pitch/tilt is disabled — the overlay projects with a flat Web Mercator transform.

## G0.6 — does it survive Tauri's webview?

Tauri does not ship a browser; it borrows the OS one. On Windows that is WebView2 (Chromium),
so the Chrome numbers *should* carry over — but "should" is what this gate exists to remove.
The proposal schedules desktop at P6, and discovering there that the particle core is unusable
in the shell that ships it would invalidate five phases.

Run it:

```bash
volta run --node 20.20.1 -- pnpm -C aether/spike tauri dev
```

`src-tauri/` wraps the *same* frontend — no port, no second implementation. Under Tauri the page
detects `__TAURI_INTERNALS__`, runs the sweep itself, and pushes each row through a
`report` command to `src-tauri/bench-results.jsonl`.

Two mechanics worth recording, because both cost a cycle:

- **`println!` alone loses everything.** `tauri dev` launches a detached GUI process whose
  stdout does not reliably reach the shell that started the build. The file is the load-bearing
  half of `report`; stdout is a convenience.
- **The window is pinned to 987×910 and non-resizable.** That is not cosmetic — see below.

### The confound that nearly produced a false finding

The first run looked like a clear result: WebView2 roughly *half* Chrome's frame rate at the top
of the range — baseline 26.8 fps where Chrome did 60.4. A tidy, plausible, publishable "Tauri
costs you 2×".

It was an artefact. The Tauri window had opened at **1920×1009** while every Chrome measurement
was taken at **987×910** — **2.16× the pixels** on renderers that are fill-rate bound. The
comparison was never between two webviews; it was between two canvas sizes.

Two changes now make that unrepeatable: the window is pinned to exactly the canvas Chrome was
measured at, and **every benchmark row carries its own canvas size and megapixel count**. A
frame rate without its canvas size is not a measurement, and the harness now refuses to emit
one.

The general lesson is the same one the SondeHub `200`-with-an-error-body taught: *the dangerous
failure is the one that returns plausible-looking data.* A crash gets investigated; a believable
number gets written down.

The *second* clean-looking run was corrupted too, differently: particle counts appeared mid-sweep
that the sweep never sets (10,000 · 170,000 · 731,025 — slider-shaped values) and the canvas
changed size partway through, because the app opens a real window on a real desktop that someone
can touch. So the sweep now defends itself: controls are disabled behind a warning banner while
it runs, the count is re-asserted immediately before each reading, and **every row carries
`wanted` vs actual plus a `trusted` flag with a reason**. Untrusted rows are reported, never
averaged in.

### Result — WebView2 vs Chrome, identical canvas (987×910), same GPU

Tauri 2.11.5 · WebView2 151.0.4129.86 · Windows x86_64 · 9/9 rows trusted, single canvas size.

| engine | primitives | Chrome | WebView2 | Δ fps |
|---|---:|---|---|---:|
| **baseline** | 205,209 | 60.0 fps · 17.0 ms | 59.9 · 17.0 ms | **−0.2 %** |
| **baseline** | 820,836 | 59.9 · 17.0 ms | 60.0 · 17.0 ms | **+0.2 %** |
| **baseline** | 3,279,721 | 60.4 · 19.6 ms | 59.9 · 17.0 ms | **−0.8 %** |
| maplibre-gl-wind | 204,800 | 30.0 · 35.8 ms | 30.9 · 35.9 ms | +3.0 % |
| maplibre-gl-wind | 819,200 | 30.0 · 34.6 ms | 30.0 · 35.6 ms | 0.0 % |
| maplibre-gl-wind | 3,276,800 | 33.8 · 34.4 ms | 28.6 · 37.9 ms | −15.4 % |
| weatherlayers-gl | 204,800 | 60.0 · 17.1 ms | 59.8 · 17.9 ms | −0.3 % |
| weatherlayers-gl | 819,200 | 38.3 · 28.9 ms | 32.4 · **60.7 ms** | −15.4 % |
| weatherlayers-gl | 3,276,800 | 11.9 · 92.2 ms | 11.4 · **166.6 ms** | −4.2 % |

**G0.6 passes, and the answer is boring in the best way.** The chosen engine is within ±1 % of
Chrome across the whole range — at the top it is actually *smoother* in WebView2 (p95 17.0 ms
vs 19.6 ms). WebView2 is Chromium, and for this workload it behaves like Chromium.

The two libraries we are not choosing show more spread, and the interesting part is not the fps
column but the **p95 tails**: `weatherlayers-gl` roughly doubles its worst-frame time under
WebView2 (28.9 → 60.7 ms, 92.2 → 166.6 ms) while its average holds up. Had one of those been
the pick, "same average, twice the stutter" is exactly the kind of thing that would have been
discovered at P6 with five phases already built on it.

**Scope of this result:** Windows only. macOS (WKWebView) and Linux (WebKitGTK) are untested and
must not be inferred from it — WebKitGTK in particular is the platform where a GPU particle
layer can silently land on software rendering.

## Bugs this harness caught in itself

Recorded because the first three would have been blamed on a candidate library later, and the
fourth is the kind of thing that ships.

1. **`crypto.getRandomValues()` throws above 65,536 bytes per call.** Seeding 1M particles
   needs a 4 MB buffer. Fill it in chunks.
2. **Passing a mutable params object by reference defeats every change check.** The engine held
   the same object the UI mutates, so `params.particleCount !== this.params.particleCount`
   compared a value with itself and the particle-count slider silently did nothing. Engines now
   copy on entry. Caught only because a coverage sweep reported `actual: 1000000` for every
   requested count.
3. **The position codec used 256 where it had to use 255 — a silent +0.392%-per-frame drift.**
   Storing `hi = floor(p*256)/255` and reading back `hi + lo/255` reconstructs `p * 256/255`,
   which compounds to **1.265× per second**. It does not crash or render black; particles just
   slide uniformly southeast fast enough to swamp the actual wind, so the map shows a plausible
   diagonal streak field and looks *almost* right. It was caught by looking at a screenshot and
   asking why a global wind field had no gyres in it — not by any test. With 255 the round trip
   is exact, because `floor(p*255) + fract(p*255) == p*255`.
4. **A light basemap made a working renderer look broken.** On `positron` the particles were
   measurably there — 7% pixel coverage — and visually almost absent. Switched to a dark style.
   Every product in this space uses a dark ground for the same reason.

One measurement caveat, not a bug: `__spike.coverage()` must be called in the same task as a
`step()`. The context is created with `preserveDrawingBuffer: false`, so once the browser's own
rAF loop is running, reading pixels outside a frame returns all zeros.

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
