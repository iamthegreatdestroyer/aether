// Cross-check harness: our shipped computePasses vs Skyfield, same TLE, same window.
import { readFileSync } from 'node:fs';
import { computePasses } from './passes_bundle.mjs';

const [l1, l2] = readFileSync('spike/iss.tle', 'utf8').trim().split('\n').map(s => s.trim());
const startMs = Date.parse(process.argv[2]);
const passes = computePasses(l1, l2, 40.7128, -74.006, startMs, 48);
for (const p of passes) {
  console.log([
    new Date(p.aosMs).toISOString().slice(0, 16),
    new Date(p.losMs).toISOString().slice(0, 16),
    p.maxElevDeg.toFixed(1),
    p.visible ? 'VIS' : 'dark',
  ].join(' '));
}
