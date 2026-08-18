# Aether

A free, personal-use weather app: Windy-class visualization, a forecast-verification ledger
that compounds with use, and the atmosphere-to-space chain nobody fuses. **$0/month, no
backend, no accounts, no ads.**

> **Status: v0.3.0 — one app, four subscriptions replaced.** Live at
> [iamthegreatdestroyer.github.io/aether](https://iamthegreatdestroyer.github.io/aether/); also
> an installable PWA and a Tauri Windows desktop app whose Rust-side transport reaches the
> sources browsers are refused.
>
> **Weather**: million-particle wind at four altitudes · radar with a recovering failover
> chain · VIIRS satellite · ⚡ live lightning (GLM parsed in-browser, ~20 s from the sky) ·
> 🔥 Smoke Story (FIRMS fires ray-tested against surface wind, PM2.5 truth) · ⚠ **NWS warning
> polygons, with the alert banner sitting above the temperature on the card** ·
> "Is this weird?" (73-year ERA5 percentiles) · **"Who Was Right?" four-model receipts scored
> against real observations** · storm ledger · ensemble cones + honesty labels · IFS-vs-AIFS
> divergence.
>
> **And the things other apps charge for**: 🌊 **Marine** — NOAA tide curves with the measured
> gauge printed beside the prediction, nearest-buoy sea state, wave model, moon
> *(vs Navionics, $50/yr)* · ✈ **Air** — live ADS-B aircraft with route lookup, desktop only
> because every open feed refuses browsers *(vs Flightradar24)* · 🥾 **Trails** — OSM trails
> with the weather sampled at each trail *(vs AllTrails+ $36/yr, Gaia $40/yr)* ·
> ☀ Space — CME arrival countdowns, aurora × cloud, ISS/Tiangong visible passes
> (SGP4 cross-checked against Skyfield), live radiosondes.
>
> Tier B runs on GitHub Actions: wind textures, storm ledger, fire clusters, divergence and
> marine stations refresh 6-hourly; the **36-source endpoint contract** is probed daily.
>
> ```bash
> volta run --node 20.20.1 -- pnpm -C aether dev   # http://localhost:5175
> ```

Full plan: [`docs/ACTION_PLAN.md`](docs/ACTION_PLAN.md).
Source research: `../Kimi_Agent_Free Weather App Proposals/`.

## What's here

| Path | What it is |
|---|---|
| `src/data/sources.mjs` | **The endpoint contract.** Single source of truth for every external URL, with license, attribution, CORS state and rate limit. Plain ESM so the CI probe needs no build step. |
| `src/data/sources.d.ts` | Types for the contract. |
| `src/data/denylist.ts` | Permanently excluded sources, each with the durable reason. Enforced at layer registration. |
| `src/config/flags.ts` | `NONCOMMERCIAL_SOURCES` and the other gates. |
| `scripts/probe-sources.mjs` | Verifies the contract against reality. Zero dependencies. |
| `scripts/gen-attribution.mjs` | Generates `ATTRIBUTION.md` from the contract; `--check` fails CI on drift. |
| `packages/mesh-bridge/` | Reserved, intentionally empty GPL-isolation slot for Proposal 2. |
| `docs/adr/` | Architecture decisions. |

## Verify the contract

```bash
node scripts/probe-sources.mjs
```

Last full run: **36/36 sources matched**, 2026-08-18.

## Why the probe exists

The entire $0/month architecture is other organisations' generosity, revocable without notice.
That is not hypothetical — it has already happened twice:

- **RainViewer's free tier collapsed in January 2026** (nowcast, satellite and composites
  removed, zoom capped at 7). LibreWXR is primary radar today *because* of that.
- **NOAA moved its real-time solar-wind JSON** out of `/products/solar-wind/` into
  `/json/rtsw/` in the **four days** between the proposal's research probes (2026-08-12) and
  the action plan's verification pass (2026-08-16).

A daily run turns "the app mysteriously broke" into "SWPC moved a path on the 14th."

The probe asserts status **and** CORS **and** a minimum body size, because status alone is not
proof of data: SondeHub answers `HTTP 200` with the plain-text body `"Duration must be
either ..."` when `duration` is malformed — its `duration` parameter is an enum
(`3d, 1d, 12h, 6h, 3h, 1h, 30m, 1m, 15s, 0`), not a number of seconds. A status-only probe
called that healthy.

## Ground rules

1. **No hard-coded weather URLs.** Import from `src/data/sources.mjs` or it doesn't ship.
2. **Attribution is not optional.** CC BY attaches to *display of the data*, so personal use
   does not waive it. `ATTRIBUTION.md` is generated — add a source, get its obligation.
3. **The denylist is permanent.** Every entry was ruled out for a reason that doesn't expire.
4. **GPL stays behind `packages/mesh-bridge`.** Personal use fires no copyleft trigger today;
   the boundary is what keeps a future sharing decision from becoming a rewrite.
5. **Rate limits are etiquette, enforced centrally.** One fetch scheduler with backoff — not
   per call site.

## Next

The roadmap is complete. Open directions (each needs a deliberate decision, not a keyboard):
Proposal 2's mesh (`packages/mesh-bridge` stays reserved), MTG-LI European lightning when an
open lane appears, and the ledger's leaderboard once enough scored days accumulate. See
[`docs/ACTION_PLAN.md`](docs/ACTION_PLAN.md) — §10–11 record how each deferred item fell.
