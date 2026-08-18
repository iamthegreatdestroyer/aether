# Aether — Action Plan

**Derived from:** `Kimi_Agent_Free Weather App Proposals/` (plan.md, weather_proposals_sec00–07, research/dim01–08 + wide01–05, cross_verification, insight)
**Re-grounded:** 2026-08-16 against live endpoint probes, live npm registry, and this machine.
**Scope:** Proposal 1 ("Aether") is the build target. Proposal 2 ("Aether Mesh") is a phase-2 module with an explicit trigger (§7).

---

## 0. Ground truth — what changed since the proposal was written

The proposal's data claims were live-probed 2026-08-12. I re-probed on 2026-08-16 (GET with `Origin:` header, checking `Access-Control-Allow-Origin`). **Eleven of fourteen core endpoints confirmed exactly as documented.** Four things are different, and three of them change the build.

### 0.1 Corrections that change the plan

| # | Proposal says | Measured 2026-08-16 | Impact |
|---|---|---|---|
| **C1** | Particle engine = fork of `@astrosat/windgl` (§5.2.1, dim06 §5) | npm `@astrosat/windgl@0.1.0` — **published 2019-04-03, last modified 2022-04-04, `peerDependencies: {mapbox-gl: ^0.53.1}`** | **Highest-impact correction.** The named starting point for P1 (the critical path, and the report's own "hardest phase") is abandonware pinned to a 2019 mapbox-gl. It will not drop into MapLibre v5/v6. **Live alternatives exist** — see §2.4. |
| **C2** | SWPC solar wind at `services.swpc.noaa.gov/products/solar-wind/plasma-1-day.json` (§3.2.1, Table 5.1) | **404.** Also 404: `plasma-2-hour`, `plasma-7-day`, `mag-2-hour`. Live path is **`/json/rtsw/rtsw_wind_1m.json`** + **`/json/rtsw/rtsw_mag_1m.json`** (both 200, CORS `*`) | Solar Chain's solar-wind sparkline is coded against a dead namespace. One-line fix — but only if caught before P4. Rest of `/products/` tree is alive (`noaa-planetary-k-index.json`, `alerts.json` → 200). |
| **C3** | GFZ Kp is "live-probe verified ✅", served as **Tier A client fetch** (Table 5.1 row 3) | `kp.gfz.de/app/json/` → **200 but NO `Access-Control-Allow-Origin` header** | The *official* Kp source is **not browser-reachable**. Solar Chain in the PWA build must proxy it (Cloudflare Worker — pulls a slice of Tier B forward), or use SWPC's `noaa-planetary-k-index.json` in-browser **labelled as an estimate** (which §5.3.2 already requires) and reserve GFZ for the Tauri native build. |
| **C4** | MapLibre GL JS **v5** (§5.2.1) | **v6.0.0 shipped 2026-07-22; v6.4.0 released today.** 5 minor releases in 4 weeks. v5 line tops out at 5.24.0 | Version decision needed at P0, not discovered at P1. See §2.5. |

### 0.2 Corrections in your favour

| # | Proposal says | Measured 2026-08-16 | Impact |
|---|---|---|---|
| **G1** | `api.met.no` sends no CORS header / 403 from datacenter → "native-only, web needs proxy" (dim08 §1) | **200 with `Access-Control-Allow-Origin: *`** (with identifying User-Agent) | One fewer proxy dependency. MET Norway is usable directly from the PWA. Identifying User-Agent + "Yr" naming ban still apply. |
| **G2** | SWPC endpoints "unverified firsthand… FLAG" (cross_verification §7) | **Verified working, CORS `*`:** `noaa-planetary-k-index.json`, `alerts.json`, `ovation_aurora_latest.json`, `json/rtsw/rtsw_wind_1m.json`, `json/rtsw/rtsw_mag_1m.json`, `json/goes/primary/xrays-1-day.json` | The open flag from cross-verification is closed. Solar Chain's data floor is real. |
| **G3** | LibreWXR = single-agent discovery, medium confidence, no SLA | **Alive.** `api.librewxr.net/public/weather-maps.json` → 200, CORS `*`, `{"version":"2.0",...}`, 10-minute radar frames, RainViewer-v2-compatible shape confirmed | The load-bearing single-source discovery holds. No-SLA risk unchanged — failover chain still mandatory. |

### 0.3 New observations worth designing around

Found while building and running the probe harness (§2 G0.3), which is the point of building it before the app rather than after.

- **Solar Chain's payloads are 46,000× larger than they need to be.** `rtsw_wind_1m.json` is **2,708 KB / 3,749 records** — a 24-hour rolling window at 1-minute cadence — and `rtsw_mag_1m.json` is **1,526 KB**. Putting either on a refresh loop would be a mobile data disaster. There are **summary endpoints carrying the live value in 59 and 60 bytes**: `products/summary/solar-wind-speed.json` and `products/summary/solar-wind-mag-field.json`, both CORS-open. **Design rule for P4: summary endpoints for the live strip and the polling loop; the 1-minute history only when the user opens the detailed sparkline, then cached.** (Note the plausible-looking `/json/rtsw/rtsw_wind_5m.json` does not exist — 404.)
- **OVATION aurora JSON is 919,721 bytes.** ~0.9 MB per fetch on a phone. Fetch on demand when the aurora card opens; never poll. Decimate server-side in Tier B if it becomes a problem.
- **SondeHub's `duration` is an enum, not a number of seconds** — valid values are `3d, 1d, 12h, 6h, 3h, 1h, 30m, 1m, 15s, 0`. An invalid value returns **HTTP 200 with the plain-text body `"Duration must be either …"`**. My first probe pass used `duration=3600`, got a 200, and scored it healthy while receiving 64 bytes of error text. **Consequence, now baked into the harness: status alone is not proof of data.** The contract carries `minBytes` and `mustNotContain`, and both were negative-tested against that exact request. Correct call returns 788 KB.
- **`data.ecmwf.int/forecasts/` returned HTTP 429** on one probe. The documented 500-connection portal cap is enforced and reachable. The Tier B cron needs retry-with-backoff from its first commit, not as later hardening.
- **`aviationweather.gov` confirmed no CORS** (proposal correct). Proxy or native build required — and this is the observation side of the *verification ledger*, so it sits on the P3 critical path, not in polish.
- **`curl -I` is not a valid CORS probe.** A HEAD-based first pass reported "no CORS" for both SondeHub and met.no; GET showed `Access-Control-Allow-Origin: *` on both. Had that gone uncorrected, met.no would have been wrongly written off as native-only — repeating the exact error in the source research.

### 0.4 This machine

| Tool | State | Action |
|---|---|---|
| Node | **v18.20.8** at `C:\Program Files\nodejs\node.exe` | **Blocker.** Vite requires `^20.19.0 \|\| >=22.12.0`. |
| Volta | **2.0.2 installed, `node@20.20.1` already the default runtime** — but `C:\Program Files\nodejs` wins the PATH | Fix is PATH ordering, not an install. See §2.1. |
| pnpm | 10.24.0 ✅ | — |
| git | 2.49.0 ✅ | Project dir is **not** a git repo yet. |
| gh | 2.78.0 ✅ | Needed for Tier B Actions cron + Pages. |
| Rust / cargo | **absent** | Needed for Tauri at P6. Not urgent; do not install yet. |
| Python | 3.14.3 ✅ | Fine for Tier B GRIB tooling. |

---

## 1. Locked decisions — do not re-open

These are settled by Chapter 7 and the cross-verification. Re-litigating them is the main way this project stalls.

1. **Build Aether first, Mesh second.** Mesh's best features consume Aether's ledger and nowcast; building radio before data strands the hardware with nothing to say.
2. **Tier A (keyless, serverless, $0) is the shipping baseline.** Tier B is bolt-on. Every feature degrades gracefully without it.
3. **One TypeScript codebase, WebGL, PWA + Tauri.** Flutter and KMP wrap MapLibre Native, whose portable custom-layer problem is unsolved upstream — the particle layer would be re-implemented per platform.
4. **Personal use only.** This is what unlocks the non-commercial quarter of the data catalog and sidesteps every copyleft trigger. It is a design decision, not a limitation.
5. **Isolate the non-commercial cluster** (WSPR, SuperDARN, INTERMAGNET, NMDB) **and any GPL dependency** behind flags/module boundaries **from the first commit.** Five lines now vs. a rewrite later.

---

## 2. Phase 0 — Gate (do all of this before writing app code)

Target: one weekend. Nothing in P0–P6 starts until G0.1–G0.5 pass.

### G0.1 — Fix the Node runtime
Volta already has the right version; the system install shadows it. Put Volta's shim dir ahead of `C:\Program Files\nodejs` in the user PATH, then confirm:

```bash
node --version && npm --version
```

Exit test: `node --version` reports v20.20.1 or newer in **both** PowerShell and Git Bash. If reordering PATH is fiddly, install Node 22 LTS system-wide instead — either resolution is acceptable, but do not start P0 on Node 18.

### G0.2 — Repo skeleton with compliance wired in on commit #1 ✅ **DONE 2026-08-16**
Repo created at `C:\Users\sgbil\Kimi\Weather_App\aether`, commit `b745638`, 18 files. Still to do by hand: **push it to GitHub as a public repo** — public is what makes Actions minutes unlimited and Pages free, which is the entire basis of Tier B costing $0.

Shipped in commit #1, per §5.3.2 and §5.5.1:
- **`src/data/sources.mjs`** — the endpoint contract, 24 sources, each with license, exact attribution string, measured CORS state, tier, rate limit and first-hand verification date. Authored as ESM + `sources.d.ts` rather than `.ts` for one reason: the CI probe imports it with **zero dependencies and zero build step**. A contract that needs a toolchain to verify stops being verified.
- **`src/data/denylist.ts`** — 9 permanently excluded sources (Blitzortung, mPING, PurpleAir, WWLLN, EMADDC, raw space-track reposting, Aurorasaurus-as-live, HAARP instrument endpoints, Windy/Ventusky scraping), each with the *durable* reason and the replacement. `assertNotDenied()` runs at layer registration.
- **`src/config/flags.ts`** — `NONCOMMERCIAL_SOURCES` gating WSPR/SuperDARN/INTERMAGNET/NMDB, plus `TIER_B_PIPELINE`, `WORKER_PROXY`, `MESH_BRIDGE`.
- **`packages/mesh-bridge/`** — declared, empty, with the transport-agnostic `MeshTransport`/`MeshObservation` boundary contract and a README explaining why an empty package ships on commit #1.
- **`LICENSE`** (MIT, own code only, with an explicit note that it does not cover the data) and **`ATTRIBUTION.md`** — *generated* from the contract by `scripts/gen-attribution.mjs`, so a new source cannot ship without its obligation. 11 sources require attribution; 13 are public domain and listed anyway as provenance.
- **`docs/adr/0001-maplibre-version.md`** — G0.5's decision, recorded with its revisit trigger.

### G0.3 — Endpoint contract probe in CI ✅ **DONE 2026-08-16**
`scripts/probe-sources.mjs` + `.github/workflows/probe-sources.yml` (daily at 07:17 UTC, deliberately off the hour; also on push to the contract, plus manual dispatch).

**Result: 24/24 sources match the contract.** Tier A subset reported separately so a drifting esoteric source never masks a broken core one.

The probe asserts **status AND CORS AND minimum body size AND a forbidden-content marker** — not status alone. That hardening is not defensive over-engineering; it is a direct response to the SondeHub soft-failure in §0.3, where a `200` accompanied a 64-byte error string. Both guards were **negative-tested against that exact request** and confirmed to fire. It uses GET, never HEAD.

`gen-attribution.mjs --check` also runs in CI and fails the build if `ATTRIBUTION.md` drifts from the contract.

Exit test: ✅ green, scheduled, failing loudly, and demonstrated to fail correctly.

### G0.4 — Particle-engine spike ⚠️ **the critical de-risk** — 🟡 **harness built 2026-08-16; measurement is yours**

This exists because of correction **C1**. The report sizes P1 at 50–60 hours assuming `windgl` is a working drop-in. It is not — it is 7 years stale against `mapbox-gl@0.53`.

**The harness is built and running** at [`aether/spike/`](../spike/) (commit `58aed3b`): two canvases, MapLibre 5.24.0, a real GFS fixture, a baseline WebGL2 engine at 1M particles, and a HUD that computes the exit-test verdict and proves whether the two-canvas split is working.

```bash
volta run --node 20.20.1 -- pnpm -C aether/spike dev
```

**What is verified:** the pipeline runs clean over 300 stepped frames with no GL error; particle count is honoured (2k/20k/200k/1M → 2,025/20,164/200,704/1,000,000, perfect squares); screen coverage scales monotonically 1.1% → 94.1%, sub-linearly at the top from overlap — which is what proves particles are genuinely advected and drawn. `tsc` clean, production build succeeds.

**What is not, and cannot be, verified without you: the frame rate.** `requestAnimationFrame` is suspended whenever the tab is not compositing, and GL submission is async, so the headless run reported a nonsense 31,578 fps. **A human with the window visible has to settle this gate.** Then the phone, over LAN — the dev server binds all interfaces for exactly that.

Evaluate in this order:

| Candidate | Version / freshness | License | Note |
|---|---|---|---|
| **`maplibre-gl-wind`** | v0.2.1, **modified 2026-08-15** | MIT | Purpose-built for MapLibre, actively developed. **Try this first.** |
| **`weatherlayers-gl`** | v2026.5.2, modified 2026-06-13 | MPL-2.0 **OR** a custom `LICENSE_TERMS_OF_USE.md` | Mature. Read the dual-license carefully — MPL is fine for personal use; the alternate term exists for a reason. |
| **`deck.gl`** overlay | v9.3.10, modified 2026-08-11 | MIT | Fallback path if custom-layer integration fights you. |
| Port `cambecc/earth` | MIT, algorithm lineage | MIT | The report's actual intellectual source. Highest effort, zero dependency risk, fully understood. |

The **two-canvas pattern** is already wired up and instrumented — the HUD's basemap-repaint counter is the proof. Hold the camera still: repaints must fall to zero while particle fps stays high. If it tracks the particle rate, the split isn't working and you're repainting the whole map every frame, which is the exact failure the pattern exists to prevent.

Exit test: **60 fps at 1M particles on the laptop, p95 ≤ 20 ms, and ≥ 30 fps on your phone.** The HUD colours the verdict for you. If no candidate clears it in a weekend, **stop and re-plan P1** — do not roll it into P0 and let it consume a month.

**A seventh correction, found while building the fixture: NOMADS OPeNDAP has been retired** (NWS SCN25-81 — `nomads.ncep.noaa.gov/dods` now returns a notice page). The **filter CGI that Tier B actually depends on still works**, so §5.2.3's pipeline is intact — but the plain-text escape hatch that would have avoided GRIB decoding entirely is gone. One useful side effect: [`spike/tools/build_fixture.py`](../spike/tools/build_fixture.py) is now a working, independently-validated, dependency-free GRIB2 template-5.3 decoder. If ecCodes proves awkward in the Actions runner at P1, that file is a fallback that already exists.

### G0.5 — Pin the MapLibre major version
Per **C4**. Recommendation: **pin v5.24.0** for P0–P2. The v6 line is three weeks old and shipping a minor release weekly; the particle-layer ecosystem you depend on has had no time to catch up, and P1 is already the risky phase. Revisit v6 at P5 when the app is stable and v6 has settled. Record the decision and the revisit trigger in `docs/adr/0001-maplibre-version.md`.

---

## 3. Build phases — the report's roadmap, corrected

Effort figures are the report's (one hobby dev, ~8–10 h/week). I've flagged where my findings move them.

| Phase | Deliverable | Corrections applied here | Effort | Exit test |
|---|---|---|---|---|
| **P0 — Skeleton** ✅ **shipped 2026-08-16** (commit `0d10b83`) | PWA: map + forecast cards, offline-first boot, **ledger write path live** | MapLibre 5.24.0 pinned exact; Data Sources dialog from the contract; SW + manifest; Pages deploy workflow ready. Verified boot trace: stale-snapshot at t≈92 ms, fresh at ~1 s spacing (scheduler chain). Ledger logs the full 168-pt hourly grid per fetch. | done | ✅ **exit closed 2026-08-17: WebAPK minted + installed on the S25+** (`org.chromium.webapk.a75fb01fda8a4df30`), launched standalone (no browser chrome), full app functional over 5G against the live deployment |
| **P1 — Particle core** ✅ **shipped 2026-08-16** (commit `11cc609`) | Wind particle map live in the app | Spike baseline engine promoted (shaders verbatim, +`clearTrails`); two-canvas as product code; quality ladder w/ down-only adaptive stepping; hover picker citing the GFS cycle; **Tier B cron wired into the Pages workflow** — pure-Python GRIB2 decoder in `scripts/`, walks back unpublished cycles, degrades to committed last-known-good. Verified: 65% trail-equilibrium coverage at 501k particles headless; **picker vs Open-Meteo at valid time: max 1.13 m/s / 15° — passes**. +6 kB gzip. | done (the G0.4 spike absorbed the hard part) | ⬜ owner: live 60 fps with pane composited (spike measured it twice) + phone smoothness |
| **P2 — Observation canvas** ✅ **shipped 2026-08-16** (radar+satellite) | LibreWXR radar w/ 13-frame loop **incl. 6 nowcast frames**, timeline scrubber, VIIRS satellite | **Failover exit test passed live**: block librewxr → RainViewer (7 frames, honestly loses nowcast, amber badge); block both → IEM (11-frame CONUS loop); unblock → **recovers to primary**. Every provider switch goes through the registry door. **GLM lightning deferred explicitly** — needs its own Tier B lane (NetCDF/HDF5 from S3 → GeoJSON); scheduled with P4's Tier B expansion. | done | radar loop animates ✅ · failover ✅ |
| **P3 — Trust moat** ✅ **v1 shipped 2026-08-17** | *Who Was Right?* live: 4-model UTC receipts (ECMWF/GFS/ICON/best_match), obs capture, T+1 scorer, leaderboard w/ MAE + plain-language bias | **CORS resolved via NWS station obs** (US, with 48 h backfill — scores hours the app slept through) + Sensor.Community citizen-median (global, opportunistic); aviationweather = Tauri-native upgrade. Scorer verified against real KNYC obs: 8 scores, 4 models ranked, idempotent. v1 (local-time) receipts excluded from scoring — a tz shift would masquerade as model bias. | v1 done | 30-day meaningful-ranking bar is met by accumulation — receipts compound from today |
| **P4 — Vertical stack** ✅ **v1 shipped 2026-08-17** | Space panel: Kp strip (labelled NOAA estimate per C3), 60-byte solar-wind summaries polled only while open, **aurora × cloud** per location, **Balloon Truth** (nearest SondeHub sonde vs model column, altitude-interpolated — DFM sondes report no pressure) | All three contract corrections honored: summaries not the 2.7 MB history, OVATION on-demand only (grid index math verified), estimate labelling. Verified live: OVATION physics sensible (Reykjavík 30%/Tromsø 21%/Fairbanks 1% at 22:45Z), **NYC sonde vs model Δ +0.1 °C @ 1801 m**. CC BY-SA shown on-card, side-by-side never blended. DONKI CME countdown deferred (needs key mgmt). | v1 done | Kp≥6-night answer machinery verified at any Kp — the verdict function is exercised at high-lat reference points |
| **P5 — Ensemble story** (wk 25–30) | *Confidence Cone* + AI-vs-physics Divergence | **§0.3:** ECMWF portal returns 429 — backoff + retry in the cron from the first commit of this phase | ~25–30 h | Divergence map renders for any forecast hour |
| **P6 — Ship polish** (wk 31–36) | Tauri desktop, alerts, offline | **Rust toolchain install lands here**, not earlier. Tauri also resolves the CORS gaps (native HTTP stacks ignore CORS) — GFZ Kp and aviationweather.gov both become direct calls | ~35–40 h | Fresh-boot offline opens with last forecast + basemap; alert fires from cron push |

**Total:** the report's ~260–300 h stands, **plus P0's gate (~15–20 h) and the P1 uncertainty from C1.** Realistic band: **300–360 hours**, ~9–11 months at 8–10 h/week. P0–P2 still yields a genuinely good app by month three, which remains the right hedge against the standard hobby-project failure mode.

---

## 4. Endpoint contract — verified 2026-08-16

This table is the source of truth for `src/data/sources.ts`. Status is my own measurement today.

| Source | Endpoint | Status | CORS | Tier | Attribution string |
|---|---|---|---|---|---|
| Open-Meteo | `api.open-meteo.com/v1/forecast` | 200 | `*` | A | "Weather data by Open-Meteo.com" (linked) |
| NWS points | `api.weather.gov/points/{lat},{lon}` | 200 | `*` | A | none required; descriptive User-Agent |
| NWS alerts | `api.weather.gov/alerts/active` | 200 | `*` | A | none required |
| MET Norway | `api.met.no/weatherapi/locationforecast/2.0/compact` | 200 | `*` ✅ **(was documented as native-only)** | A | "MET Norway"; identifying UA mandatory; "Yr" banned in app name |
| LibreWXR | `api.librewxr.net/public/weather-maps.json` | 200, `version:"2.0"` | `*` | A | "LibreWXR"; "Radar-DPC" for Italian tiles |
| RainViewer *(fallback)* | `api.rainviewer.com/public/weather-maps.json` | 200 | `*` | A | "Weather data by RainViewer" + link (**mandatory**) |
| Iowa IEM *(fallback 2)* | `mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi` | 200 | `*` | A | fair use |
| NASA GIBS | `gibs.earthdata.nasa.gov/wmts/epsg3857/best/...` | 200 | `*` | A | "NASA GIBS/Worldview" |
| SWPC Kp *(estimate)* | `services.swpc.noaa.gov/products/noaa-planetary-k-index.json` | 200 | `*` | A | public domain — **label "estimate" in UI** |
| SWPC alerts | `services.swpc.noaa.gov/products/alerts.json` | 200 | `*` | A | public domain |
| SWPC solar wind *(live)* | `services.swpc.noaa.gov/products/summary/solar-wind-speed.json` | 200, **59 B** | `*` | A | **use this for the strip + polling loop** |
| SWPC IMF Bt/Bz *(live)* | `services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json` | 200, **60 B** | `*` | A | Bz south is the aurora trigger |
| SWPC solar wind *(history)* | `services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json` | 200, **2,708 KB** | `*` | A | ⚠️ **corrected path** (`/products/solar-wind/*` = 404); **on demand only** |
| SWPC magnetometer *(history)* | `services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json` | 200, **1,526 KB** | `*` | A | ⚠️ corrected path; on demand only |
| GOES X-ray | `services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json` | 200 | `*` | A | public domain |
| OVATION aurora | `services.swpc.noaa.gov/json/ovation_aurora_latest.json` | 200 (**920 KB**) | `*` | A | public domain — fetch on demand only |
| **GFZ Kp** *(official)* | `kp.gfz.de/app/json/` | 200 | ⚠️ **NONE** | A*/B | "GFZ German Research Centre for Geosciences" — **needs proxy or native build** |
| SondeHub | `api.v2.sondehub.org/sondes/telemetry?duration=1h` | 200, 788 KB | `*` | A | "SondeHub (CC BY-SA 2.0)" — **share-alike on derived datasets**; ⚠️ `duration` is an **enum**, not seconds |
| Sensor.Community | `data.sensor.community/airrohr/v1/filter/box=...` | 200 | `*` | A | "Sensor.Community" |
| CelesTrak | `celestrak.org/NORAD/elements/gp.php` | 200 | `*` | A | 2-hour polling floor |
| OpenFreeMap | `tiles.openfreemap.org/styles/liberty` | 200 | `*` | A | basemap attribution |
| **aviationweather.gov** | `aviationweather.gov/api/data/metar` | 200 | ⚠️ **NONE** | A*/B | public domain — **needs proxy or native build** |
| ECMWF open data | `data.ecmwf.int/forecasts/` | ⚠️ **429** | none | B | "This service is based on data and products of ECMWF" + © year, CC BY 4.0 link |
| NOMADS GFS | `nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl` | 200 | none | B | public domain |

`A*` = Tier A in the **Tauri native** build (no CORS in native HTTP stacks); needs the Cloudflare Worker proxy in the PWA.

---

## 5. Compliance — a P0 deliverable, not a P6 one

Attribution obligations survive the personal-use carve-out. Ship the "Data Sources" screen early; per §5.3.2 it doubles as provenance documentation and is itself part of the trust identity the whole product is built on.

- [ ] `ATTRIBUTION.md` + in-app Data Sources screen, seeded from §4's right-hand column
- [ ] ECMWF exact wording: *"This service is based on data and products of ECMWF"* + `© [year] ECMWF` + CC BY 4.0 link + note modifications — **legally required even privately**
- [ ] MET Norway: identifying User-Agent set globally; "Yr" absent from the app name (Aether complies)
- [ ] NWS: descriptive User-Agent with contact
- [ ] SondeHub CC BY-SA 2.0: **display sonde data alongside model data, never blended into a derived product** — that's what keeps share-alike from propagating
- [ ] GOES GLM: cite NCEI DOI `10.7289/V5KH0KK6`
- [ ] Deny-list enforced in the layer registry (§2 G0.2)
- [ ] Non-commercial cluster behind `NONCOMMERCIAL_SOURCES`
- [ ] Central fetch scheduler with backoff — Open-Meteo ≤10k/day, RainViewer 100 req/IP/min + zoom ≤7, CelesTrak 2-hour floor, ECMWF backoff on 429

---

## 6. Risk register

| Risk | Severity | Status | Mitigation |
|---|---|---|---|
| **Particle-engine base is abandonware (C1)** | **High** | **New — from this review** | G0.4 spike before P1 starts; three live alternatives identified; `cambecc/earth` port as the zero-dependency floor |
| Single-operator free services revoked | High | Carried from report | LibreWXR → RainViewer → Iowa IEM chain, built at P2; client tile caching; MRMS self-render lane in reserve; daily probe (G0.3) gives early warning |
| Endpoint drift without notice | Medium | **Demonstrated** — SWPC moved a namespace within 4 days (C2) | Daily CI probe; every URL in one contract module |
| P1 overruns and stalls the project | Medium | Carried | Timeboxed spike; P0–P2 ships something usable regardless; parallel P2/P4 are the motivation-sustaining "fun" work by design |
| CORS gaps block Tier A features (C3, aviationweather) | Medium | **Sharpened** | Cloudflare Worker proxy (free, 100k req/day ≈ 100× headroom) OR ship those features native-only until P6 |
| GitHub Actions-as-cron policy | Low | Carried | Small, offset, idempotent jobs; Oracle Always Free (2 OCPU/12 GB) as the escape hatch |
| WebGL perf on low-end phones | Medium | Carried | Two-canvas pattern; particle-count scaling to ~100k on integrated GPUs; auto quality detection |
| Novelty window closes on AI-vs-physics | Low | Carried | It's a window, not a moat — ship P5 early, and note the *ledger* is the thing that actually compounds |

---

## 6a. The desktop version — Tauri, and the risk the proposal doesn't flag

The proposal puts Tauri 2.x at **P6** and treats desktop as packaging: same TypeScript, 3–15 MB
installer instead of Electron's 85–250 MB, "100% shared frontend". That framing is right about
the code and wrong about the renderer, in one platform-specific way that matters a great deal
for *this* app.

### Tauri does not ship a browser — it borrows the OS one

| Platform | Webview | WebGL2 outlook for a 1M-particle layer |
|---|---|---|
| **Windows** | WebView2 (Chromium) | ✅ Effectively identical to the Chrome numbers in §2 G0.4. **This machine has WebView2 151.0.4129.86 installed** — Chromium 151, current. |
| **macOS** | WKWebView (Safari/WebKit) | 🟡 WebGL2 is supported and Metal-backed. Expect it to work; expect different perf. Untestable here — no Mac. |
| **Linux** | **WebKitGTK** | 🔴 **The real risk.** WebGL2 exists but hardware acceleration is driver- and compositor-dependent, and falls back to software rendering (llvmpipe) more readily than Chromium. A GPU particle engine that silently lands on llvmpipe does not run slowly — it runs at single-digit fps. |

Electron would avoid the Linux problem by bundling Chromium everywhere, at 85–250 MB per install and
a self-updating Chromium to maintain. That is the actual trade, and the proposal presents only
one side of it.

**This does not change the recommendation** — Tauri is still right, because Windows is the
primary target here and WebView2 is Chromium. But it does add a gate.

### What this machine already has

Better than expected. Desktop is close to one command away, not a from-scratch setup:

| Prerequisite | State |
|---|---|
| `rustup` | ✅ 1.29.0, default host `x86_64-pc-windows-msvc` |
| Rust toolchain | ✅ **installed 2026-08-16** — rustc/cargo 1.97.1 stable-msvc |
| MSVC linker | ✅ Build Tools 2019 + 2022, MSVC 14.44.35207 |
| Windows 10 SDK | ✅ present (x64/x86/arm64) |
| WebView2 runtime | ✅ 151.0.4129.86 |

`tauri info` reports the full Windows chain green. Desktop builds work on this machine today.

### G0.6 — ✅ **DONE 2026-08-16. Passes.**

Rust toolchain installed (rustc 1.97.1 stable-msvc), the existing spike wrapped in a Tauri 2.x
shell at [`aether/spike/src-tauri/`](../spike/src-tauri/), and the same benchmark re-run
inside WebView2 at an identical 987×910 canvas.

**The chosen engine is within ±1% of Chrome across the entire range** — and at the top of it
WebView2 is actually *smoother* (p95 17.0 ms vs Chrome's 19.6 ms). WebView2 is Chromium, and
for this workload it behaves like Chromium.

| engine | primitives | Chrome | WebView2 | Δ |
|---|---:|---|---|---:|
| **baseline** | 205,209 | 60.0 fps | 59.9 fps | **−0.2 %** |
| **baseline** | 820,836 | 59.9 | 60.0 | **+0.2 %** |
| **baseline** | 3,279,721 | 60.4 · p95 19.6 ms | 59.9 · p95 **17.0 ms** | **−0.8 %** |
| weatherlayers-gl | 819,200 | 38.3 · p95 28.9 ms | 32.4 · p95 **60.7 ms** | −15.4 % |

The last row is why the gate was worth running even though it passed: the libraries we are
*not* choosing roughly double their **p95 tail** under WebView2 while their averages hold.
"Same average, twice the stutter" is precisely the failure that would otherwise surface at P6
with five phases already built on top of it.

**Scope: Windows only.** macOS (WKWebView) and Linux (WebKitGTK) are untested and must not be
inferred from this — WebKitGTK remains the platform where a GPU particle layer can silently
land on software rendering.

**Desktop is therefore de-risked for the primary target, and P6 loses most of its uncertainty.**

Two further desktop notes that P6 should carry:

- **Tauri resolves the CORS gaps for free.** Native HTTP stacks ignore CORS, so `gfz-kp` and
  `aviationweather.gov` (§0.1 C3, §0.3) become direct calls in the desktop build with no
  Cloudflare Worker. The desktop version is genuinely *more capable* than the PWA here, which
  is an argument for pulling it earlier than P6, not later.
- **Linux, if you ever want it,** should be treated as a separate decision with its own
  measurement — not assumed to follow from a working Windows build.

---

## 7. Proposal 2 — Aether Mesh trigger

**Do not buy hardware yet.** The trigger is explicit in Chapter 7: Mesh starts **after Aether's P3 ships**, because Mesh's whole value is consuming a ledger and nowcast that already exist. Buying LoRa nodes before P3 strands them with nothing to say.

When P3 exits, Phase 1 of Mesh is one T-Echo + BME280 (~$70), Meshtastic on a private channel at 900 s cadence, consumed through the `mesh-bridge` package you declared empty at G0.2. Full budget $200–360 for 3–5 stations, zero recurring. Sequence: node → reconciliation → gateway → downlink, each phase de-risking the next-most-uncertain claim.

Two constraints to carry forward now, because they shape `mesh-bridge`'s interface: `meshtastic-sdk` is **GPL-3.0 and pre-1.0** (isolated module boundary handles both), and the bridge interface must be **transport-agnostic** so a MeshCore pull-telemetry variant can slot in on the same hardware.

---

## 8. This week

| # | Gate | Status |
|---|---|---|
| 1 | **Fix Node** (G0.1) | 🟡 solved to one elevated paste: Volta's shims (incl. node 20.20.1) live in `C:\Program Files\Volta` but MACHINE PATH lists `nodejs` first — prepend Volta (admin) |
| 2 | Repo + compliance skeleton + `mesh-bridge` slot (G0.2) | ✅ done — commit `b745638` |
| 3 | Endpoint probe + CI workflow (G0.3) | ✅ done — 24/24 green, guards negative-tested |
| 4 | **Particle spike** (G0.4) | ✅ **CLOSED 2026-08-17: Galaxy S25+ (Adreno 830) = 59.9 fps @ 1,000,000 particles, p95 16.9 ms, PASS badge** — driven over USB via adb, HUD screenshot as evidence. Baseline engine passes on every tested surface: Chrome, WebView2, Android. |
| 6 | **Tauri webview smoke test** (G0.6 — see §6a) | ✅ passes · baseline within ±1% of Chrome in WebView2 |
| 5 | ADR 0001 pinning MapLibre v5.24.0 (G0.5) | ✅ done — `docs/adr/0001-maplibre-version.md` |
| — | Push `aether/` to GitHub as a **public** repo | ✅ **done 2026-08-16** — https://github.com/iamthegreatdestroyer/aether · live at https://iamthegreatdestroyer.github.io/aether/ · first CI deploy green, **Tier B texture cron ran on the runner** (sidecar builtAt 23:36:27Z), daily probe + 6-hourly wind cron armed |

**Update 2026-08-16, later:** P0 shipped (commit `0d10b83`) — see the roadmap table. The owner-gated list is now: the PATH fix, the GitHub push (which also activates the Pages deploy workflow already in the repo), the spike on your phone, and **the P0 phone-install half of the exit test** — same LAN visit, two birds.

Three things need you specifically: the PATH fix, the GitHub push (your account), and **reading the frame rate off the spike** — a benchmark requires a visible window and your actual phone, neither of which an agent has.

**G0.4 is the one that matters.** It is the only remaining unknown that can change the shape of the project, because correction C1 removed the floor the report's hardest phase was standing on. Everything around the measurement is done; the measurement itself is a weekend of your time, and it must happen before P0 rather than during P1.

Then P0 starts, and the report's roadmap runs as written.

---

## Appendix — verification method

All endpoint status in §0 and §4 measured 2026-08-16 via `curl` GET with `Origin: https://aether.example` and an identifying User-Agent, reading the response code and `Access-Control-Allow-Origin` header. Library versions, publish dates, licenses and peer dependencies read from the live npm registry the same day. Toolchain versions read from this machine.

One method note worth keeping: an initial pass using `curl -I` (HEAD) reported *no CORS header* for SondeHub and met.no. Re-probing with GET showed `Access-Control-Allow-Origin: *` on both. **HEAD is not a reliable CORS probe** — the probe script in G0.3 must use GET.


---

## 9. Live Windy.com reconnaissance — 2026-08-17, driven hands-on in the owner's Chrome

Windy v51.1.1 (built 2026-08-11), explored feature-by-feature. One claim of ours corrected,
several confirmed, and a P-next shortlist extracted.

### Claim correction (Pattern-12 applies to our own research too)

**"Live radiosonde overlays exist nowhere in consumer apps" is FALSE as stated.** Windy has a
`Radiosondes` overlay: WMO launch sites on the map, per-ascent temp/dewpoint profiles with
wind barbs, skew-T toggle, derived indices (tcon/ccl/lcl), nearest-station cards, GeoJSON
download. Source: **NOAA MADIS**, fm35/netCDF, post-ascent.

**What survives, narrower and still real:** (1) nobody — including Windy — overlays the
MODEL's predicted sounding against the measurement; the diff IS Balloon Truth's novelty.
(2) SondeHub streams ascents LIVE mid-flight incl. amateur launches; MADIS is post-ascent
official sites only. (3) MADIS is a better US obs source than our NWS-station chain for the
ledger — noted as an upgrade candidate.

### Confirmed by direct observation

- **No space weather anywhere** in the ~60-layer catalog. No aurora, no Kp. Solar Chain's
  whitespace holds.
- **Compare forecasts = stacked parallel strips, no verification.** ECMWF 88° vs GFS 95° for
  the same Tuesday, presented without an arbiter. *Who Was Right?* remains unoccupied.
- **New: "AI-enhanced forecast" modal** — meteoblue-powered blend now pushed as the
  recommended default over "Classic". Their trust story is "believe our blend"; ours is
  receipts. These are opposite bets, and ours is the one they structurally cannot copy.
- **Per-day confidence percentages** (Mon 70%, Tue 60%…) in the forecast header — a shipped,
  lightweight ensemble-spread signal. Validates P5's Confidence Cone direction.

### P-next shortlist extracted from the session

1. **Scalar field under the particles** — Windy's signature look is particles OVER a colored
   temp/precip raster. Our two-canvas split already supports it (scalar = one more raster in
   MapLibre; Tier B already renders PNG textures). Highest visual payoff per effort.
2. **Display-side model switcher fused with receipts** — Windy's pinned ECMWF/GFS/ICON picker,
   plus the one thing theirs can't show: per-model MAE at YOUR location, in the picker.
3. **Unified time axis** — Windy's timeline drives every layer at once; ours scrubs only
   radar. Architectural upgrade worth doing before more time-aware layers accumulate.
4. **Altitude levels** — same GFS file, more bands (850/500/300 hPa U/V textures) in the
   existing cron.
5. **Manifest `screenshots`** — both Windy and Aether currently lack them (their DevTools
   showed the same richer-install warning ours gets). Trivial PWA polish.

### 9.1 Runtime introspection — the fast path (2026-08-17)

Clicking feature-by-feature is the slow way to survey a competitor. Windy's plugin API is a
documented, public global (`window.W`), so the capability surface can be *queried* instead:
46 models and 68 overlays enumerated in three calls, no UI walking. Recorded here because the
technique generalises to any SPA competitor review.

**Measured scale (their real numbers, not marketing):**

| | |
|---|---|
| Models | **46 total** — 18 global, 28 regional. Finest: AROME-HD **1.3 km**, ACCESS-C 1.5 km, HRRR 3 km |
| Global backbone | ECMWF 9 km / GFS 22 km (fh 360 h) / ICON 13 km / meteoblue AI, all 12-hourly |
| Overlays | **68** registered |
| Vertical levels | **16** per model: surface, 100 m, 950/925/900/850/800/700/600/500/400/300/250/200/150/10 hPa |
| ECMWF overlays | 27 variables at those levels |

**Architecture confirmed** (`W.TileLayerUtils` exposes `decodeHeader` / `decodeImage`;
`W.interpolator` exposes `getLatLonInterpolator` / `getXYInterpolator`): values ship as encoded
RGBA raster tiles, are decoded client-side, and the picker interpolates from the same decoded
texture the map draws. **This is exactly Aether's P1 pipeline** — our GFS→PNG→shader path and
`sampleWind()` reading the same texels is the same design, arrived at independently and
already validated to ±1.13 m/s against Open-Meteo.

**Colour technique** (not their table — that is their design work, and we build our own ramp):
value→RGBA lookup precomputed to **2048 steps**, anchored on meteorologically meaningful
breakpoints with a deliberate discontinuity at 273.15 K so freezing reads instantly. That
anchoring convention is the transferable idea for our scalar layer.

**Scope note:** this was capability reconnaissance against the page as served — feature
surface, architecture, conventions. No weather data was extracted; the research's standing
rule (never scrape Windy/Ventusky model data, which is licensed to them) is unaffected and
still holds. One introspection call was blocked by the browser tooling for containing
token-like strings; it was not worked around.

### 9.2 The wide tour — ideas that came from looking, not from hunting (2026-08-17)

Explored hurricane tracker, 3D, EFI, thermals, drought, dust/CAMS, airgram routes. The three
findings below are NOT "features to copy" — they are reframings that change what Aether could
be, and none were on any shortlist before the tour.

#### A. EFI asks a different question than every other layer — and we can ask it better

ECMWF's Extreme Forecast Index legend reads **"unusually calm ←→ extreme wind"**. It does not
show the forecast VALUE; it shows *how unusual the forecast is against that location's own
climatology*. Every other layer in every weather app answers **"what will it be?"** EFI
answers **"should you care?"** — 30 km/h is unremarkable in Patagonia and a story in Singapore.

**The connection: Aether can compute a PERSONAL version, and is uniquely positioned to.**
Windy uses ECMWF's model climatology. We have two better sources already in hand:
- **Open-Meteo's ERA5 archive back to 1940** — already in the endpoint contract, unused. A
  percentile for today's value against 80 years at that exact point is one API call.
- **The ledger itself.** We have been recording observations per location since P0. Over time
  that becomes a *personal* climatology — not "unusual for this grid cell" but "unusual for
  the record THIS app has kept HERE."

Feature shape: **"Is this weird?"** — a per-location normality percentile on the forecast
card. Cheap (ERA5 is one keyless call), immediately meaningful on day one, and it deepens
with the ledger exactly like *Who Was Right?* does. It is the same compounding-trust bet
applied to a second axis.

#### B. Hurricane tracks are the perfect ledger subject, and the diff is sitting right there

The tracker draws the **observed past track** (solid, with dated waypoints) and the
**forecast track + cone** (dashed) on the same canvas — truth and prediction, same pixels —
and never diffs them. Three model chips (NHC-CP / UKM / ECMWF) can only be viewed ONE AT A
TIME, and they disagree materially: for the same Saturday, ECMWF said 12 bft / category 2
while UKM said 10 bft / no category, with visibly different cone geometry.

NHC reissues forecasts every 6 h and publishes observed positions. So **"which model has been
closest for THIS storm so far"** is computable *while the storm is still approaching*. That is
*Who Was Right?* applied to the highest-stakes forecast that exists, at the moment the answer
matters most — and nobody ships it. ForecastWatch verifies post-hoc and B2B; Windy shows
tracks without scores.

#### C. `Thermals` proves the derived-index category ships

Thermals is not a raw model variable — it is a computed "is today good for paragliding" index.
Its existence validates proposal concept #10 (Linked Lifestyle Indices) as a real product
category rather than a nice-to-have.

#### Smaller observations worth keeping

- **The time axis changes granularity with the data.** Normal layers = hourly scrubber; EFI =
  daily tabs with Temperature/Wind/Rain sub-selectors. Our planned unified time axis should
  adapt its resolution per layer rather than forcing one grid — radar wants 10-minute frames,
  EFI wants days.
- **3D is the paywall.** Their chosen premium hook is spatial, not data — everything factual
  stays free. Useful signal about what users actually pay for.
- **Composition layers run on a separate model stack** (CAMS 40 km; the dust view offered
  "13 more" models). Aerosol/chemistry is a distinct ingest, not a variable of the NWP models.
- **Drought comes from CzechGlobe** with a research-partner credit — even Windy outsources
  the long-timescale layers to institutes rather than deriving them.

### 9.3 The rest of the tour — route forecasts, honesty labels, and the platform play

#### D. "Route forecast" is a different query shape entirely

The distance tool is not a ruler. Its header reads **"Display route forecast for:
Car/hike | Boat | VFR | IFR | Airgram"**, and it exports GPX. That is weather sampled along a
*path*, evaluated **at the time you will actually be at each point** — a trajectory query,
not a point query. Leaving at 15:00, the midpoint should be scored at 16:30, not now.

Every layer Aether has is `f(position, forecast_hour)`. This is `f(position, arrival_time)`.
The machinery is a polyline plus a departure time, and it is the *same shape* as proposal
concept #7 **Smoke Story** ("fires → trajectory → local PM arrival timeline"). Build the
trajectory sampler once and both features fall out of it. Also worth noting: the profiles
(boat vs VFR vs IFR) are just different variable sets over the same query — aviation cares
about ceiling/visibility/icing, boats about waves/wind.

#### E. Two honesty patterns worth stealing outright

1. **Per-day "predictability" percentage** on the forecast header — 70% today, sliding to 50%
   by day five. An ensemble-spread signal, named in plain language, shipped.
2. **"Convective rain (difficult to forecast)"** printed inline on the meteogram. They label
   *which part of the forecast is inherently less trustworthy*, at the point of display.

Both are exactly Aether's thesis coming from the incumbent: forecast uncertainty stated up
front rather than hidden behind a single confident number. Our ledger goes further (we can
say *how wrong this model has actually been here*), but these two are cheap and immediate.

#### F. The strategic finding: Windy is not a product, it is a platform

The plugin gallery is third parties solving problems Windy would never build:
- **CMA typhoon tracker** — a national met agency shipping its own GB/T wind-scale tracker
- **Prevención de incendios forestales · Navarra** — a Spanish region's fire-risk overlay
- **FieldGuard — HSE Field Safety** — occupational heat-stress (WBGT) for outdoor crews
- **Pressure Diff Charts Alps** — cross-section diagrams for alpine forecasting

Plus "Load plugin directly from URL" for side-loading. **The moat is not the 68 layers; it is
that domain experts build their livelihoods on top.** That is unassailable by feature parity
and irrelevant to a personal app — but the underlying insight transfers: *weather is
infrastructure for domain-specific decisions.* Aether's Linked Lifestyle Indices are the same
idea at personal scale, and the `WeatherSource`/layer-registry boundaries we already built are
the same architecture at n=1.

#### G. Constraints they hit that we also hit

**"Live alerts are supported only on native Windy.com app."** Their web app cannot push
either — exactly the finding in our own infrastructure research (something must wake and send;
a PWA alone cannot). Windy's answer was to ship a native app. Ours is the Tier B cron → FCM
topic, and P6's Tauri build. Good confirmation the constraint is real and not our mistake.

#### H. Small design decisions worth a moment

- **Animation intensity is a user setting** (Normal / High / Intensive), where Aether
  auto-adapts down-only. Theirs respects preference; ours protects the battery. The right
  answer is probably both — auto by default, user override available.
- **Every quantity has its own unit toggle** (wind in kt/bft/m/s/km/h/mph, radar in dBZ or
  mm/h, satellite in K/°C/°F). Unit handling as a first-class system, not a global metric flag.
- **High-resolution meteogram is Premium**; the standard one is free. Together with 3D being
  the paywall, the pattern is consistent: *resolution and spatial polish are paid; the
  underlying facts are free.*

### 9.4 "Is this weird?" — SHIPPED 2026-08-17, same day it was conceived

The §9.2-A idea, live: every forecast card now answers "should you care?" — today's forecast
high/low as a percentile of ±7-day-window history at that exact point, 1940–2024 ERA5, one
keyless call per location cached permanently (~162 KB gzipped, verified <2 s).

Percentile math validated against real NYC history BEFORE the code was written (30 °C ≈ p84,
33 °C ≈ p97, 35 °C ≈ p99 for mid-August — meteorologically sensible). Tier logic is quiet
when normal and loud when notable, and on its FIRST live render it found a real headline:
London's next overnight low at p100 — warmer than every one of 1,275 mid-August nights since
1940. The warm-night tier (the health signal) fired exactly as designed while both normal
cities stayed quiet.

Contract: new `open-meteo-archive` entry (separate host, CORS * verified);
`requiredAttributions()` now dedupes by display text so the two Open-Meteo endpoints carry
one legal string. DB at v5 with a hardening worth the scar: the IndexedDB upgrade trap bit a
SECOND time, through a new door — version bump and store creation were split across two
sequential tool calls and the live HMR page consumed the upgrade in between. Store creation
is now driven by a single manifest array, so the split cannot happen again and any
half-upgraded DB heals on the next bump.

### 9.5 The storm ledger — SHIPPED 2026-08-17, while Lala is still active

§9.2-B, built: *Who Was Right?* pointed at a live storm. Tier B fetches NHC/CPHC's public
ATCF decks each 6-hour advisory cycle — best track as truth, every public early aid as the
forecasts — scores track error per model per lead, and ships a 10 KB ledger. The client
renders the ranked table (n on every cell), the plain sentence, and draws the un-drawn diff:
observed track solid, latest official forecast dashed, same frame.

First real result, 22 advisories into Lala: **the human forecasters are winning by 2× —
Official 74 km mean 24–72 h track error vs Consensus 148, HAFS ~164, GFS 166, CMC 181, and
UKMET 223** — three times the official error, and UKMET is one of the three model chips the
incumbent displays without scores. ECMWF is absent from NOAA's public a-decks (licensed);
the ledger states this in its output rather than scoring a quietly diminished field.

NHC sends no CORS header (verified), so the mirror-to-Pages pattern was the design anyway —
same cadence, same degrade-to-snapshot rule as the wind texture.

### 9.6 Honesty labels — SHIPPED 2026-08-17

§9.3-E, built to a higher standard than the inspiration: Windy prints "70% predictability"
with no visible basis; Aether's per-day badge derives it —
`1 − ensemble spread ÷ climatological variability` — from 31 real GFS members (8.3 KB
gzipped/location, verified) against the same 85-year ERA5 yardstick "Is this weird?" already
cached. 100% = members agree perfectly; 0% = the forecast tells you nothing beyond the month.
The tooltip shows every step: members, range, σ, climate σ, result. The ⚡ split flag is
Windy's "convective rain (difficult to forecast)" made quantitative: shown when 25–75% of
members disagree on rain at all, with the count (e.g. 21/31 wet).

First live render read like a meteorology lecture: NYC 53→75→80% as the pattern locks in,
collapsing to 38% at day 4; contested-rain Tuesday flagged. Third Open-Meteo host in the
contract (forecast/archive/ensemble), attribution dedup already handled. Cache: 3 h TTL via
a prefixed STORE_LATEST key — no schema change, no DB version dance.

### 9.7 The trajectory sampler — SHIPPED 2026-08-18. All four tour ideas are live.

§9.3-D, built: `f(position, arrival_time)`. Route mode turns map clicks into waypoints;
pick a pace (car/bike/hike/boat) and a departure (now/+1/+3/+6 h); samples are spaced by
TRAVEL TIME (one per ~30 min underway, 3–12 points) and the entire route costs **one**
Open-Meteo request — the multi-location comma-list form was live-verified to return an
ordered array before the code was written. UTC internally so cross-timezone routes stay on
one clock; local times rendered per point. Map colors each sample by precip probability;
the bar calls out the wettest stretch, or says "dry run".

First verification run answered like a road trip: NYC→Boston by car departing +3 h —
overcast leaving the city, clearing through Connecticut, **fog on the Massachusetts approach
at 03:30 AM** — pre-dawn New England in August, captured by arrival-time sampling where a
"now" map would have shown none of it.

Smoke Story remains explicitly deferred: it is this sampler pointed at a fire/PM data lane
that does not exist yet (FIRMS + HRRR-Smoke are their own Tier B work).

**The Windy-tour scoreboard: all four ideas shipped within ~30 h of the tour** — "Is this
weird?" (9.4), storm ledger (9.5), honesty labels (9.6), trajectory sampler (9.7). The
classic roadmap resumes at P5 (divergence layer) and P6 (Tauri desktop).

(NOTE: P5 row replace missed — see §9.8 below.)

### 9.8 P5 shipped — the ensemble story (2026-08-18)

**Confidence Cone**: 📈 on every card. One multi-model ensemble call (~17 KB gz) now feeds
both the honesty badges (GEFS-only, matching their caption) and hourly p10–p90 bands for
GEFS (31) + ECMWF ENS (51), medians, min/max whiskers, the deterministic card value overlaid
dashed — "the confident number you were given is one path through a widening cone" — and a
GEFS rain-agreement strip. Verified: spread widens 1.6°→7.3° across the week; ENS visibly
sharper than GEFS at day 7 (4.0° vs 7.3°).

**Divergence layer**: 🤖 toggle. Tier B fetches IFS + AIFS 2 m temp for one cycle at
24/48/72/96/120 h via byte-Range requests against the .index files (live-verified layout;
CCSDS packing → ecCodes on the runner, WSL-verified locally in the CI-identical env),
colorizes |diff| transparent-below-0.5 °C → amber → magenta, ships ~40 KB world PNGs.
Client renders as a MapLibre image source with a lead selector and the honest legend: "not
an error map — a humility map." First build: 5.4% of the globe >2 °C at +24 h rising to
17.7% at +120 h, max divergence 22.5 °C. The 2025–26-window feature exists in production.

### 9.9 P6 — the desktop ship (2026-08-18)

The last classic-roadmap phase. G0.6 proved the renderer inside WebView2 months of work ago
(in project time: two days); P6 wraps the real app and cashes the native cheque:

- **`src-tauri/` at the app root** — thin shell, same TypeScript bundle as the PWA. The G0.6
  spike shell stays quarantined in `spike/`.
- **`tauri-plugin-http`** — Rust-side fetch, immune to webview CORS, scoped by capability to
  exactly the two `A-native` hosts (`kp.gfz.de`, `aviationweather.gov`). The fetcher gained a
  transport shim: under Tauri every scheduled fetch can use the native path; in the PWA the
  shim stays null and nothing changes.
- **The first cashed cheque: official Kp.** Since P4 the Kp strip carried the required
  caveat "NOAA estimate · official Kp: GFZ Potsdam" because GFZ sends no CORS header. Under
  the desktop shell `fetchKpSeries()` reaches GFZ directly and the label becomes
  "GFZ Potsdam — official Kp (CC BY 4.0) ✓". Same panel, truer data, honest label either
  way. (GFZ JSON shape live-verified first: `{datetime[], Kp[], meta:{license:'CC BY 4.0'}}`.)
- **METAR truth for the ledger** remains the documented second cheque — needs station
  resolution work, explicitly deferred.
- **Self-check over stdout-that-doesn't-exist**: on boot under Tauri the app fetches Kp via
  the native path and writes the result to `aether-native-check.jsonl` through a `report`
  command — the G0.6 files-are-the-truth-channel pattern, reused.
- **`desktop.yml`**: MSI built on workflow_dispatch or version tags, artifact-uploaded;
  deliberately NOT part of the 6-hourly data deploys.

## 10. The deferred backlog — worked through post-roadmap

### 10.1 METAR truth — SHIPPED 2026-08-18. The second native cheque, cashed.

The obs chain's biggest hole was international truth: London and Tokyo scored against
Sensor.Community citizen medians, current-hour-only, app-open-hours-only. METARs fix both
dimensions at once — global station history, quality-controlled, from the proposal's original
first-choice source — and P6's native transport is what made them reachable.

**The deferred hard part evaporated on probe.** "Station resolution work" was deferred at P6
because it looked like it needed a station directory. It doesn't: `GET /api/data/metar?bbox=
<±0.7°>&format=json&hours=N` returns every nearby airport's reports WITH per-report lat/lon
(verified 2026-08-18: London box → EGLL/EGLC/EGWU/EGKB at 20-minute cadence; Tokyo box →
RJTT/RJTI/RJTF/…). Nearest-station resolution is one haversine over the response.

- **Chain order is a continuity decision**: `nws-obs` stays first so an established US ledger
  (KNYC) never silently switches truth source mid-stream; `metar` second (native-only, global
  history, 48 h backfill); `sensor-community` remains the PWA fallback. Provider is stamped
  per observation, so mixed-provider histories stay legible in the receipts.
- **One obs per hour, closest to the top of the hour** — the same dedupe rule as NWS, so the
  scorer needs zero changes. `wspd` knots → m/s at the capture boundary.
- **The self-check now cashes both cheques**: boot under Tauri fetches GFZ Kp AND runs a
  read-only `captureMetar` for London, reporting station + hours + latest observation to
  `aether-native-check.jsonl`.
- Desktop CI proven same day: first `desktop.yml` run green on windows-latest; the P6 push's
  Pages deploy + contract probe also green. Releases are a `git tag` away.

### 10.2 CME watch — SHIPPED 2026-08-18. The "key mgmt" deferral dissolved on probe.

DONKI was deferred at P4 for key management. Re-probed: NASA's published DEMO_KEY is the
documented personal-use path (not a secret), api.nasa.gov sends `Access-Control-Allow-Origin:
*`, and the measured quota (X-Ratelimit-Limit: 10/h per IP) is fine for a panel-open-only
fetch behind a 3 h cache. Tier A, no key management at all.

- `WSAEnlilSimulations` gives STRUCTURED arrival predictions — `estimatedShockArrivalTime` +
  `kp_18/90/135/180` clock-angle estimates — no message-text parsing needed.
- Three honest states: incoming (countdown + Kp range + run provenance + "±7 h typical"),
  quiet ("no Earth-directed CME in the last 7 days of Enlil runs" — a real answer), and
  unavailable (fetch failed — a different answer, never conflated with quiet).
- Probe pinned to the 2024 Gannon storm window so the contract check never goes stale;
  429 tolerated in CI because DEMO_KEY quota is per-IP and runners share pools.
- Verified live at ship time with a real event: Earth-directed CME, shock arrival
  2026-08-20 12:00Z (~54 h out), predicted Kp 0–4, from the 2026-08-16 23:00Z Enlil run.

### 10.3 Altitude wind levels — SHIPPED 2026-08-18. The level slider, Aether-style.

The Windy tour's level slider (16 levels there), realized as four: Sfc / 850 / 500 / 250 hPa.
Pressure-level GFS U/V decodes with the SAME pure-Python template-5.3 path as 10 m wind —
no decoder work, just four NOMADS filter fetches pinned to one resolved cycle (the switcher
must never mix model runs). "latest" keeps its P1-era name as the surface file so committed
artifacts and old clients stay valid; levels are data/wind/{850,500,250}.{png,json}.

- windLayer gains setLevel(): teardown + re-init (trails from the old level would be a lie
  at the new one). Chips render only while particles run; choice persists.
- Build verified physical: max speeds ascend 26.6 → 42.4 → 64.0 → 102.6 m/s (Sfc→250).
- Picker cross-checked at 250 hPa against Open-Meteo GFS south of NZ (winter jet):
  37.8 m/s @ 172° vs 40.9 @ 173° — direction within 1°, speed within the known
  decimation+quantization cost.

### 10.4 Smoke Story — SHIPPED 2026-08-18. Composed, not collected.

The proposal's §4.1.3, built without a single new heavy dependency — every plane was already
in the stack, which is the point of the story:

- **fires**: FIRMS keyless CSVs measured CORS-closed (global 24 h file 8.8 MB) → Tier B:
  `build_fire_clusters.py` bins VIIRS detections to 0.25° clusters as same-origin GeoJSON
  (first live run: 108,624 detections → 11,693 clusters, 1.28 MB raw, ~300 KB gzipped,
  loaded only on toggle). HRRR-Smoke stays out: CONUS-only Lambert grid, and the ray test
  answers the personal question without a plume model's false authority.
- **wind**: the surface texture the particle layer already ships, sampled AT each fire —
  a ray test ("is the wind there pointed at me?"), labelled as exactly that in the panel
  footer, never as dispersion modelling.
- **PM2.5**: Sensor.Community medians (≥3 stations) — the measured truth that keeps the
  ray test honest. The contract entry's role line promised this pairing at P0.

Panel per location: verdict line, top-3 fires by FRP with distance/bearing/off-axis angle,
PM2.5 with EPA-band colouring; 🔥 map layer (dots sized by detections, coloured by FRP)
behind the registry door as source `firms`. Verified live: NYC 2 clusters/none toward;
London 11 (August grass fires)/none toward, PM2.5 2 µg/m³ across 11 sensors agreeing;
Tokyo 6/none toward. Clean error log through panel + layer cycle.

### 10.5 GLM lightning — EVALUATED 2026-08-18: the blocker moved, a design decision remains.

Probed live (GOES-19, `noaa-goes19` S3): GLM-L2-LCFA granules every 20 s, ~280 KB each,
and — the surprise — the bucket sends `Access-Control-Allow-Origin: *`. The assumed Tier B
NetCDF lane was the WRONG frame entirely:

- **Tier B (cron density grid) is dishonest here and stays rejected**: lightning is a
  nowcast; a 6-hour-stale flash map is theater. This deferral was correct and is now
  permanent, with numbers.
- **Tier A live is real**: list the current hour's prefix, fetch the LATEST granule, parse,
  plot — genuinely live lightning, honestly labelled "flashes in the last 20 s". The one
  cost: GLM L2 is netCDF4/HDF5, so the browser needs an HDF5 reader (h5wasm, ~1 MB wasm) —
  the app's first binary-parsing dependency. That is a design decision (dependency weight vs
  a live-lightning wow), not an engineering blocker, and it is parked HERE until decided.

Everything else on the deferred backlog is shipped: METAR truth (10.1), CME watch (10.2),
altitude winds (10.3), Smoke Story (10.4).

### 10.6 Live lightning — SHIPPED 2026-08-18. The only honestly-live layer in the app.

§10.5's design decision was taken: the wow won. GLM flashes from GOES-East + GOES-West,
20-second granules fetched straight from the CORS-open S3 buckets and parsed IN THE BROWSER
with h5wasm — verified against a live granule in spike/glm_h5_test.mjs before the layer was
written (flash_lat/lon plain float32; flash_energy int16 with ARRAY-WRAPPED scale/offset
attrs; flash_quality_flag != 0 dropped).

- Rolling 5-minute window; dots sized by log10(flash energy), fading white→ember with age;
  poll every 20 s per satellite with granule-key dedupe; missed granules self-heal.
- Button title is the live status line: flash count + newest-granule age + the coverage
  honesty ("Americas field of view" — Europe/Asia have no open GLM equivalent).
- Dependency cost, measured not estimated: a SEPARATE lazy 4.8 MB chunk (bundler inlined
  the wasm; ~1.0 MB gzipped), fetched on first toggle only, then service-worker cached.
  Main bundle unchanged at 1.17 MB.
- First live toggle: 246 flashes / newest granule 48 s old; 65 s later: 1006 flashes /
  29 s old, zero console warnings — both satellites parsing, window filling as designed.

THE ENTIRE DEFERRED BACKLOG IS NOW CLOSED: 10.1–10.6, all probe-first, all verified live.

### 10.7 FIRMS live fires — SHIPPED 2026-08-18. The MAP_KEY upgrade, and a CORS lesson.

The Smoke Story's fire plane upgraded from "24 h window, 6-hourly snapshot" to "detections
minutes old, queried at panel-open" — and the architecture assumption flipped AGAIN on probe:

- **Do not conclude CORS from error paths.** The dummy-key 400 sends no CORS header; the
  keyed SUCCESS response sends `Access-Control-Allow-Origin: *`. What looked like native
  cheque #3 is plain Tier A — the live path works in the PWA, no desktop required. The
  probe script now enforces CORS claims only on 2xx (the general form of this lesson).
- **Key handling**: MAP_KEY requested with the owner's email via FIRMS's own endpoint,
  delivered to Gmail, retrieved from there. It lives in localStorage ONLY (panel UI to
  paste/forget it; ····-masked when set), never in source — the contract's probe uses an
  invalid key on purpose: a stable 400 proves the endpoint alive without spending quota.
- Three VIIRS orbiters queried per location (SNPP/NOAA-20/NOAA-21, 350 ms politeness vs
  the 5000/10 min quota), low-confidence pixels dropped, ~5 km client-side clustering,
  per-fire "seen HH:MMZ" stamps. Live failure falls back to the cron snapshot and SAYS SO.
- Verified live: rows stamped 08:05-08:06Z queried at ~08:25Z — 2.0URT rows land ~20 min
  after overpass, hours fresher than advertised NRT. NYC's picture changed from 2 cron
  clusters to 9 live ones including a toward-verdict — better data changing the verdict is
  the feature working, not a regression. Keyless fallback + zero-error console verified.

### 10.8 Live fire dots — SHIPPED 2026-08-18. The map follows your eyes.

The 🔥 layer now runs two planes on one toggle: viewport-scoped LIVE queries (white-stroked
dots, same ~20-min-after-overpass lane as the panel) when zoomed below ~continental span
with a MAP_KEY, and the global cron snapshot at world scale or keyless. Live REPLACES the
snapshot for the covered view — two ages of dot at once would lie.

Quota discipline is structural: queries fire on moveend (700 ms debounce) against a 25%-
padded box, so pans inside it requery nothing (measured: 0 requests on a small pan) and an
unchanged view holds for 2 min. A world-span live query would be a multi-MB CSV and a quota
bonfire — the span threshold IS the honesty rule.

Verified live: world → cron; central US z5 → live, 132 clusters, newest 08:10Z (~25 min);
zoom-out → cron again; Congo Basin z5 → live, 47 clusters, newest 01:15Z (night passes);
zero HTTP errors across the tour. `__aether.fires()` + `flyTo()` joined the debug hook.

### 10.9 Fire dot receipts — SHIPPED 2026-08-18. Click a fire, get its story.

Every 🔥 dot is now clickable: intensity (decimal below 10 MW), detection provenance (live
dots carry their seen-stamp + age; snapshot dots say "cron snapshot" instead of pretending),
distance/bearing to the nearest saved location, and the ray test — extracted into a single
shared threatFor() so the popup and the Smoke panel CANNOT disagree.

Engineering shape: the click handler and a public openDotAt(lng, lat) drive the same path,
so the receipt is reachable both by mouse and by callers that know coordinates (debug hook
today; panel-row → map jump is a natural follow-on). The dark-themed popup guards against
superseded clicks by identity check. Debug hook grew map/clickAt/fireDot — the pane-hidden
lesson: queryRenderedFeatures needs compositing, so headless verification must drive
source-side paths, not rendered-pixel paths.

Verified live: nearest dot to (-100, 40) → "0.4 MW · 1 detection · seen 08:07Z (92 min ago)
· 2143 km W of New York · ↛ away from New York — wind at fire 5.9 m/s, 76° off-axis".

## 11. Stations overhead — SHIPPED 2026-08-18. The contract's last promise, kept.

CelesTrak sat in the contract from day one with role "satellite passes" and zero consumers.
Now: ISS + Tiangong visible-pass prediction in the Space panel — the aurora × cloud pattern
applied to spacecraft.

- **src/data/passes.ts is deliberately PURE** (TLE + coords in, passes out): the spike
  bundles the exact shipped code and cross-checks it against Skyfield — 12/12 NYC passes
  matched to the minute, max elevation within ~1° (30 s sampling). The near-zenith pass
  read 87.2° vs 88.9° — sampling brushing a peak, not disagreement.
- **Visibility is the feature**: observer in civil-twilight-or-darker (Almanac low-precision
  sun) AND station sunlit (cylindrical shadow test). "No visible pass in 48 h" is a real
  answer — most passes are daylight or shadow.
- satellite.js pinned to v5: v7 ships a wasm build whose node: imports break bundling.
- TLEs cached 6 h against CelesTrak's HARD 2 h polling floor.
- Verified live: NYC's panel row IS the cross-checked pass (08-19 08:20Z, max 33°, 13%
  cloud → "go look"); London's passes exist but 100% overcast → "overcast — pass hidden";
  Tokyo 78° near-overhead tonight → "go look".
- Drive-by fix: DONKI failures are negative-cached 10 min — a quota 429 used to cost every
  panel open the scheduler's full 21 s backoff before rendering "unavailable".

### 11.1 📍 Home — SHIPPED 2026-08-18. Pin-once, not follow-me, on purpose.

One button, one browser permission prompt, and the device position becomes the first saved
location (stable id, gold marker, boot-priority hydration). The design call that matters:
**Home rounds to 2 decimals (~1 km)** where map-click locations keep 4 — locationKey feeds
the verification ledger, and 4-decimal precision would let ordinary GPS jitter between
re-pins mint a fresh ledger each time. An actual move (> ~1 km) honestly starts fresh.
Follow-me was rejected: a location that trails the device would fragment its receipt
history at every coordinate change. Reverse-geocoding skipped (Open-Meteo's geocoder is
CC BY-NC — deliberately avoided since P0); the pin is named "📍 Home", which is what it is.

Verified with stubbed geolocation: first pin lands front + hydrates live; re-pin at new
coords updates the SAME entry (1 home, count stable); denied/unavailable/timeout each get
an honest alert.

### 11.2 One-world zoom floor + particle legibility — FIXED 2026-08-18 (owner screenshot)

The desktop screenshot showed two compounding zoom-out bugs: MapLibre happily renders
WRAPPED world copies on wide windows while the particle engine draws exactly one world —
dead, unlit map on the flanks — and at world scale a million trails bury the basemap
entirely. Fixes: (1) dynamic minZoom pinned to the container — width = 512·2^z, recomputed
on resize — so one world always exactly fills the viewport and wrapping is structurally
impossible; (2) the wind CANVAS fades by zoom (0.55 at ≤z2.5 → 1.0 by z5), so the map reads
through at world scale without touching engine physics. Verified: world px ≥ viewport at
the floor, opacity ramp live.

### 11.3 The desktop was broken since P6 — and two screenshots found it (2026-08-18)

**The bug.** P6 armed `tauri-plugin-http` GLOBALLY (every `fetchJson` routes through Rust
once the transport initialises) but hand-wrote a TWO-ENTRY capability allowlist for the two
CORS-blocked hosts it was added for. So in the desktop build, 20 of 22 contract hosts
answered `url not allowed on the configured scope` — every forecast card, every layer index.
The MSI shipped that way ~8 times today.

**Why the guards missed it.** The self-check exercised only the two allowed hosts, so it
passed while the app was unusable. *A self-check that only tests the special path certifies
the special path, not the app.* The web regression check passed too — the transport is null
in the browser, so the PWA was always fine. Nothing in CI models the desktop's HTTP scope.

**The fixes** (all three, because the class of failure matters more than the instance):
1. `scripts/gen-capabilities.mjs` derives the allowlist FROM the contract (23 hosts) —
   the same generated-not-maintained pattern as `ATTRIBUTION.md`. CI runs `--check`.
2. The native self-check now fetches an ORDINARY source first (`ordinarySource: "ok 29.1C"`
   on the fixed build) — the assertion that would have caught this on day one.
3. Documented here so the next global-transport-with-scoped-permission arrives pre-warned.

### 11.4 Legibility: the map you cannot read is not a map

The same screenshots showed the basemap invisible even where particles were sparse. Measured
from the live style: land `rgb(12,12,12)` vs water `rgb(27,27,29)` — 15 values apart, so
continents and oceans were the same black; country borders `hsl(0,0%,23%)`; labels 40% grey.
The P1 "dark style" call (particles at ~7% coverage vanish on a light basemap) was right but
overshot into a black canvas.

- `src/ui/basemapLegibility.ts`: a paint-property pass at `style.load` — land lifted to
  `rgb(26,28,32)`, water dropped to a true `rgb(9,13,24)` navy (separated in BOTH value and
  hue), borders `hsl(205,22%,52%)`, labels `rgb(196,205,220)` with a 1.6 halo so they
  survive under the overlay. Data + one loop, not a forked style: OpenFreeMap ships updates,
  and a fork would freeze them. Missing layers are skipped, never thrown.
- Particle field now thins with zoom (`applyStyle` is the single writer of engine params, so
  the fps ladder and the zoom bucket compose instead of overwriting each other): density
  10%/40%/100% and trail persistence 0.82/0.91/0.96 across z<3 / z3-5 / z≥5, plus a
  continuous canvas-alpha ramp from 0.4.
- Measured with `windStep`'s pixel coverage at world zoom: **47.5% → 28.9%** lit fraction
  after tuning (and the pre-fix build was effectively saturated).
