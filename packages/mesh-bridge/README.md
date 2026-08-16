# `@aether/mesh-bridge` — reserved slot, intentionally empty

**This package ships no code yet. That is the point.**

## Why it exists on commit #1

Two independent reasons, both structural:

**1. GPL isolation.** `meshtastic-sdk` is **GPL-3.0** and, by its own ADR-004, infects its
consumers. Aether is personal-use software and never conveyed, so no copyleft obligation fires
today. But the moment a future decision is made to share the app, a GPL dependency tangled
through the core turns that decision into an architectural rewrite. Declared behind a clean
module boundary from the first commit, it stays a **relicensing decision** instead.

**2. Mesh must be a delta, not a fork.** Proposal 2 ("Aether Mesh") consumes the verification
ledger and personal nowcast that Aether has been populating since first install. Reserving the
slot now is what makes the phase-2 module cheap later. Chapter 7 of the proposal is explicit:
forking the sequence inverts the risk profile for no benefit.

## When it gets filled

**After Aether P3 ships**, not before. P3 delivers the verification ledger and personal
nowcast — the things the mesh has to say something *about*. Buying LoRa hardware before P3
strands it with nothing to report.

## The interface, when it comes

- Exposes a `WeatherSource` — the same pluggable-source abstraction the rest of the app uses,
  so "Mesh" appears in the source list alongside Open-Meteo and NWS.
- **Transport-agnostic on purpose.** Aether Mesh defaults to Meshtastic for ecosystem maturity
  and the Kotlin Multiplatform SDK, but the same SX1262 hardware can be reflashed to MeshCore,
  whose pull-based sensor role is arguably the better airtime citizen for fixed solar stations.
  The interface must not assume Meshtastic.
- Bidirectional: observations flow **up** (nodes as sensors, feeding the ledger and nowcast),
  compressed forecast bulletins flow **down** (nodes as offline clients). One ledger, two
  directions.

## Constraints to carry forward

- `meshtastic-sdk` is **pre-1.0** (`0.1.0`); its API will move. The module boundary is what
  contains that churn.
- Airtime is the binding design constraint, not bandwidth: the EU 868 MHz 1% duty cycle allows
  36 seconds of transmission per hour per node. A 15-minute telemetry cadence consumes roughly
  15% of one station's budget.
- Keep the mesh on **ISM**, never amateur bands — Part 97 prohibits the channel encryption a
  private mesh wants.

See `ACTION_PLAN.md` §7 and proposal Chapter 6.
