#!/usr/bin/env node
/**
 * Aether — endpoint contract probe.
 *
 * GETs every source in src/data/sources.mjs and asserts that status and CORS still match what
 * the contract claims. Zero dependencies, zero build step — uses only built-in fetch.
 *
 * WHY THIS EXISTS
 * ---------------
 * The entire $0/month architecture is other organisations' generosity, revocable without
 * notice. It has already happened twice in this project's short history:
 *
 *   - RainViewer's free tier collapsed in January 2026 (nowcast, satellite, composites gone).
 *   - NOAA moved its real-time solar-wind JSON out of /products/solar-wind/ into /json/rtsw/
 *     in the FOUR DAYS between the proposal's research probes (2026-08-12) and the action
 *     plan's verification pass (2026-08-16).
 *
 * A daily run turns "the app mysteriously broke" into "SWPC moved a path on the 14th".
 *
 * METHOD NOTE: uses GET, never HEAD. A HEAD-based pass falsely reported "no CORS" for both
 * SondeHub and met.no; GET showed `Access-Control-Allow-Origin: *` on both.
 *
 * Usage:
 *   node scripts/probe-sources.mjs           # all sources
 *   node scripts/probe-sources.mjs --tier A  # only browser-reachable sources
 *   node scripts/probe-sources.mjs --json    # machine-readable output
 *
 * Exit codes: 0 = contract holds, 1 = at least one source drifted.
 */

import { SOURCES } from '../src/data/sources.mjs';

const ORIGIN = 'https://aether.local';
const USER_AGENT = 'Aether/0.1 (personal weather app; contact: sgbilod@gmail.com)';
const TIMEOUT_MS = 25_000;
const CONCURRENCY = 6;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const tierArg = args.includes('--tier') ? args[args.indexOf('--tier') + 1] : null;

/** @param {import('../src/data/sources.d.ts').Source} src */
async function probe(src) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(src.probeUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { Origin: ORIGIN, 'User-Agent': USER_AGENT, Accept: '*/*' },
    });

    // Read and discard the body so the connection closes cleanly. Bounded: some payloads are
    // large on purpose (OVATION is ~920 KB) and we want that measured, not streamed forever.
    const buf = await res.arrayBuffer();

    const acao = res.headers.get('access-control-allow-origin');
    const observedCors = acao ? 'open' : 'none';

    const problems = [];

    if (!src.expectStatus.includes(res.status)) {
      problems.push(`status ${res.status}, contract expects ${src.expectStatus.join('/')}`);
    }

    // CORS is only checkable on success: error paths legitimately omit the header (measured
    // on FIRMS 2026-08-18 — the keyed API sends * on 200 but nothing on its 400s, and the
    // firms-api probe deliberately uses an invalid key so no quota is spent).
    if (res.status >= 200 && res.status < 300 && observedCors !== src.cors) {
      problems.push(
        observedCors === 'none'
          ? 'CORS header DISAPPEARED — contract says browser-reachable'
          : 'CORS header APPEARED — contract says proxy/native needed; tier can be relaxed',
      );
    }

    // A 200 is not proof of data. SondeHub answers 200 with a plain-text usage error for a
    // malformed `duration`; status-only probing called that healthy for a whole afternoon.
    if (src.minBytes != null && buf.byteLength < src.minBytes) {
      problems.push(
        `body is ${buf.byteLength}B, contract expects >= ${src.minBytes}B — ` +
          `likely a soft error returned with HTTP 200`,
      );
    }

    if (src.mustNotContain) {
      const head = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, 2048));
      if (head.includes(src.mustNotContain)) {
        problems.push(`body contains forbidden marker "${src.mustNotContain}"`);
      }
    }

    return {
      id: src.id,
      name: src.name,
      tier: src.tier,
      status: res.status,
      cors: observedCors,
      bytes: buf.byteLength,
      ms: Date.now() - started,
      ok: problems.length === 0,
      problems,
    };
  } catch (err) {
    return {
      id: src.id,
      name: src.name,
      tier: src.tier,
      status: null,
      cors: null,
      bytes: 0,
      ms: Date.now() - started,
      ok: false,
      problems: [`unreachable: ${err instanceof Error ? err.message : String(err)}`],
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Simple bounded-concurrency map — no dependency needed for this. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const targets = tierArg ? SOURCES.filter((s) => s.tier === tierArg) : SOURCES;

if (targets.length === 0) {
  console.error(`No sources match --tier ${tierArg}`);
  process.exit(1);
}

// One retry for connection-level failures only. Twice on 2026-08-18 a GitHub runner
// failed to reach two unrelated hosts (fetch failed, 0 B) while the sibling workflow's
// runner probed the identical contract green in the same minute — per-runner egress blips
// are real and should not block a deploy. HTTP-level failures (wrong status, missing CORS,
// short body) are NOT retried: those are contract answers, not network noise.
async function probeWithRetry(src) {
  const first = await probe(src);
  const transient = first.problems?.some((p) => p.startsWith('unreachable:'));
  if (!transient) return first;
  await new Promise((r) => setTimeout(r, 5000));
  return probe(src);
}

const results = await mapLimit(targets, CONCURRENCY, probeWithRetry);
const failures = results.filter((r) => !r.ok);

if (asJson) {
  console.log(JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2));
} else {
  console.log(`\nAether endpoint contract — ${targets.length} sources\n`);
  for (const r of results) {
    const mark = r.ok ? 'ok  ' : 'FAIL';
    const size = r.bytes > 1024 ? `${Math.round(r.bytes / 1024)}KB` : `${r.bytes}B`;
    console.log(
      `  ${mark} ${r.id.padEnd(22)} ${String(r.status ?? '---').padEnd(4)} ` +
        `cors=${String(r.cors ?? '?').padEnd(5)} ${size.padStart(7)} ${String(r.ms).padStart(5)}ms`,
    );
    for (const p of r.problems) console.log(`       -> ${p}`);
  }
  console.log(
    `\n${results.length - failures.length}/${results.length} sources match the contract.\n`,
  );
}

if (failures.length > 0) {
  console.error(
    `Contract drift on ${failures.length} source(s): ${failures.map((f) => f.id).join(', ')}\n` +
      `Update src/data/sources.mjs (and ACTION_PLAN.md §4) once you have confirmed the new reality.`,
  );
  process.exit(1);
}
