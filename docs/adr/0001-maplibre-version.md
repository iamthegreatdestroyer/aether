# ADR 0001 — Pin MapLibre GL JS to the v5 line for P0–P2

- **Status:** Accepted
- **Date:** 2026-08-16
- **Revisit trigger:** start of P5, or when a chosen particle library declares v6 support

## Context

The proposal (§5.2.1) specifies MapLibre GL JS **v5**. That was accurate when written on
2026-08-12. It is no longer the current release:

- `maplibre-gl@6.0.0` shipped **2026-07-22**.
- `maplibre-gl@6.4.0` released **2026-08-16** — five minor releases in four weeks.
- The v5 line tops out at **5.24.0**.

Separately, and more importantly, the particle-layer situation is unsettled (see §0.1 C1 of
`ACTION_PLAN.md`): the proposal's named engine, `@astrosat/windgl`, was published in 2019 and
declares `peerDependencies: {mapbox-gl: ^0.53.1}`. The P1 particle core — the project's
critical path and self-declared hardest phase — is therefore already carrying real
integration risk before any map-version risk is added.

## Decision

**Pin `maplibre-gl@5.24.0` for P0 through P2.**

## Rationale

1. **Don't stack two unknowns on the critical path.** P1 is the phase most likely to overrun.
   Pairing an unproven particle-layer integration with a three-week-old major release means a
   failure gives no signal about which layer caused it.
2. **The ecosystem hasn't caught up.** Custom-layer libraries have had under a month to react
   to v6. `CustomLayerInterface` is exactly the surface a particle layer depends on.
3. **A weekly minor cadence is a moving target.** Five minors in four weeks is healthy for the
   project and hostile to a hobby build schedule of 8–10 hours a week.
4. **The cost of deferring is low.** v5.24.0 is a mature terminal release of a well-understood
   line. Nothing in P0–P2 needs a v6-only feature.

## Consequences

- Globe projection and other v5 features remain available; no planned P0–P2 feature is lost.
- The upgrade debt is real but bounded, and it is scheduled rather than discovered.
- If the particle library chosen in gate G0.4 turns out to require v6, **this ADR loses and the
  library wins** — the particle engine is the harder constraint, and that is the whole point of
  running the spike before committing.

## Revisit

At the start of P5, re-evaluate: is the app stable, has the v6 line settled to a monthly
cadence, and does the particle layer support it? Supersede this ADR with 000N rather than
editing it.
