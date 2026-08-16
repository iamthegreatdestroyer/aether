# Aether

A free, personal-use weather app: Windy-class visualization, a forecast-verification ledger
that compounds with use, and the atmosphere-to-space chain nobody fuses. **$0/month, no
backend, no accounts, no ads.**

> **Status: P0 shipped.** The PWA skeleton is live: MapLibre 5.24.0 (pinned per ADR 0001) on
> the OpenFreeMap dark basemap, Open-Meteo forecast cards for saved locations (add by clicking
> the map, capped at 10), a Data Sources screen rendered from the contract, offline-first boot
> from IndexedDB snapshots, a service worker, and — live from first install — the verification
> ledger's write path logging every forecast at fetch time with the full 168-point hourly grid
> the P3 scorer will need.
>
> ```bash
> volta run --node 20.20.1 -- pnpm -C aether dev   # http://localhost:5175
> ```
>
> Verified boot trace (dev, warm snapshot): all cards render **stale-from-snapshot at t≈92 ms**
> before any network response — the offline path exercised on every boot, not a special mode —
> then refresh fresh at t=266/1280/2287 ms, the ~1 s spacing being the fetch scheduler's
> per-source politeness chain doing its job visibly.

Full plan: [`../ACTION_PLAN.md`](../ACTION_PLAN.md).
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

Last full run: **24/24 sources matched**, 2026-08-16.

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

Gate items G0.1 (Node ≥ 20 on PATH), G0.4 (particle-engine spike), then P0.
See [`../ACTION_PLAN.md`](../ACTION_PLAN.md) §2 and §8.
