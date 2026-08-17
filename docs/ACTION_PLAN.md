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
| **P0 — Skeleton** ✅ **shipped 2026-08-16** (commit `0d10b83`) | PWA: map + forecast cards, offline-first boot, **ledger write path live** | MapLibre 5.24.0 pinned exact; Data Sources dialog from the contract; SW + manifest; Pages deploy workflow ready. Verified boot trace: stale-snapshot at t≈92 ms, fresh at ~1 s spacing (scheduler chain). Ledger logs the full 168-pt hourly grid per fetch. | done | ⬜ **owner half of exit test: PWA installs on phone** (`http://<lan-ip>:5175`) |
| **P1 — Particle core** ✅ **shipped 2026-08-16** (commit `11cc609`) | Wind particle map live in the app | Spike baseline engine promoted (shaders verbatim, +`clearTrails`); two-canvas as product code; quality ladder w/ down-only adaptive stepping; hover picker citing the GFS cycle; **Tier B cron wired into the Pages workflow** — pure-Python GRIB2 decoder in `scripts/`, walks back unpublished cycles, degrades to committed last-known-good. Verified: 65% trail-equilibrium coverage at 501k particles headless; **picker vs Open-Meteo at valid time: max 1.13 m/s / 15° — passes**. +6 kB gzip. | done (the G0.4 spike absorbed the hard part) | ⬜ owner: live 60 fps with pane composited (spike measured it twice) + phone smoothness |
| **P2 — Observation canvas** ✅ **shipped 2026-08-16** (radar+satellite) | LibreWXR radar w/ 13-frame loop **incl. 6 nowcast frames**, timeline scrubber, VIIRS satellite | **Failover exit test passed live**: block librewxr → RainViewer (7 frames, honestly loses nowcast, amber badge); block both → IEM (11-frame CONUS loop); unblock → **recovers to primary**. Every provider switch goes through the registry door. **GLM lightning deferred explicitly** — needs its own Tier B lane (NetCDF/HDF5 from S3 → GeoJSON); scheduled with P4's Tier B expansion. | done | radar loop animates ✅ · failover ✅ |
| **P3 — Trust moat** ✅ **v1 shipped 2026-08-17** | *Who Was Right?* live: 4-model UTC receipts (ECMWF/GFS/ICON/best_match), obs capture, T+1 scorer, leaderboard w/ MAE + plain-language bias | **CORS resolved via NWS station obs** (US, with 48 h backfill — scores hours the app slept through) + Sensor.Community citizen-median (global, opportunistic); aviationweather = Tauri-native upgrade. Scorer verified against real KNYC obs: 8 scores, 4 models ranked, idempotent. v1 (local-time) receipts excluded from scoring — a tz shift would masquerade as model bias. | v1 done | 30-day meaningful-ranking bar is met by accumulation — receipts compound from today |
| **P4 — Vertical stack** (wk 18–24, ∥) | *Solar Chain* + *Balloon Truth* | **C2:** use `/json/rtsw/rtsw_wind_1m.json`. **C3:** GFZ Kp needs proxy — or ship SWPC estimated-Kp labelled as estimate. **§0.3:** don't poll the 920 KB OVATION blob | ~35–40 h | On a Kp≥6 night the card answers "visible from here?" using the cloud forecast |
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
| 1 | **Fix Node** (G0.1) — PATH ordering; Volta already has 20.20.1 | ⬜ **you** — 15 min, everything is blocked behind it |
| 2 | Repo + compliance skeleton + `mesh-bridge` slot (G0.2) | ✅ done — commit `b745638` |
| 3 | Endpoint probe + CI workflow (G0.3) | ✅ done — 24/24 green, guards negative-tested |
| 4 | **Particle spike** (G0.4) — 3 engines benchmarked | 🟡 baseline wins decisively; **owed: your phone + a discrete GPU** |
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
