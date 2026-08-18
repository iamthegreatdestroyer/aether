/**
 * The Space panel — Solar Chain + Balloon Truth, the "see the unseen" surface.
 *
 * Everything here renders on open, on demand: the 920 KB OVATION grid and the SondeHub
 * queries never run in the background. The 60-byte solar-wind summaries repoll each minute
 * ONLY while the dialog is open. Closing the panel stops all of it.
 */

import {
  auroraVerdict,
  azWord,
  fetchCmeOutlook,
  fetchKpSeries,
  fetchOvation,
  fetchSolarWindNow,
  kpSeverity,
  nextVisiblePasses,
  sampleAurora,
} from '../data/space';
import type { CmeOutlook } from '../data/space';
import { balloonTruth } from '../data/sondes';
import { fetchJson } from '../data/fetcher';
import { source } from '../data/sources.mjs';
import type { SavedLocation } from './locations';

/** Cloud cover now, for the aurora cross — one tiny call per location on open. */
async function cloudCoverNow(loc: SavedLocation): Promise<number | null> {
  try {
    const om = source('open-meteo');
    const u = new URL(om.baseUrl!);
    u.searchParams.set('latitude', loc.lat.toFixed(3));
    u.searchParams.set('longitude', loc.lon.toFixed(3));
    u.searchParams.set('current', 'cloud_cover');
    const d = await fetchJson<{ current: { cloud_cover: number } }>('open-meteo', u.toString());
    return d.current.cloud_cover;
  } catch {
    return null;
  }
}

export function buildSpaceDialog(): HTMLDialogElement {
  const dlg = document.createElement('dialog');
  dlg.className = 'sources-dialog space-dialog';
  document.body.append(dlg);
  return dlg;
}

let pollTimer = 0;

export function stopSpacePolling(): void {
  window.clearInterval(pollTimer);
}

export async function renderSpace(
  dlg: HTMLDialogElement,
  locations: SavedLocation[],
): Promise<void> {
  dlg.innerHTML = `<button class="dialog-close" aria-label="Close">×</button>
    <h2>Atmosphere to space</h2><p class="sources-intro">Loading the chain…</p>`;
  dlg.querySelector('.dialog-close')?.addEventListener('click', () => {
    stopSpacePolling();
    dlg.close();
  });

  // ---- solar wind (60-byte summaries; repolled while open)
  const windHtml = (w: { speedKms: number; bt: number; bz: number; time: string }) => {
    const bzSouth = w.bz < 0;
    return `
      <span class="sw-chip">wind <b>${w.speedKms}</b> km/s</span>
      <span class="sw-chip">Bt <b>${w.bt}</b> nT</span>
      <span class="sw-chip ${bzSouth ? 'sw-south' : ''}">Bz <b>${w.bz > 0 ? '+' : ''}${w.bz}</b> nT${bzSouth ? ' ⬇ south' : ''}</span>
      <span class="sw-meta">DSCOVR/ACE via SWPC · ${w.time.slice(11, 16)}Z</span>`;
  };

  const [kpSeries, wind, ovationMeta, cme] = await Promise.all([
    fetchKpSeries().catch(() => null),
    fetchSolarWindNow().catch(() => null),
    fetchOvation().catch(() => null),
    fetchCmeOutlook().catch(() => 'error' as const),
  ]);

  // ---- CME watch: three honest states — incoming, quiet, and unavailable
  const cmeHtml = (() => {
    if (cme === 'error') return `<p class="cme-row muted">CME watch unavailable (DONKI unreachable or over quota)</p>`;
    const o = cme as CmeOutlook;
    if (!o.arrival) {
      return `<p class="cme-row">quiet — no Earth-directed CME in the last ${o.windowDays} days of Enlil runs</p>`;
    }
    const hrs = Math.round((Date.parse(o.arrival) - Date.now()) / 3_600_000);
    const eta = hrs >= 0 ? `in ~${hrs} h` : `${-hrs} h ago — may be arriving now`;
    const kp = o.kpRange
      ? o.kpRange[0] === o.kpRange[1]
        ? `Kp ~${o.kpRange[0]}`
        : `Kp ${o.kpRange[0]}–${o.kpRange[1]}`
      : 'Kp estimate unavailable';
    return `<p class="cme-row cme-incoming">⚡ Earth-directed CME — est. shock arrival
      <b>${o.arrival.slice(0, 16).replace('T', ' ')}Z</b> (${eta}) · predicted ${kp}</p>
      <p class="cme-note">WSA-Enlil run ${o.simIssued ? o.simIssued.slice(0, 16).replace('T', ' ') + 'Z' : '—'} ·
      arrival predictions typically carry ±7 h</p>`;
  })();

  const kp = kpSeries?.readings ?? [];
  const latest = kp[kp.length - 1];
  const sev = latest ? kpSeverity(latest.kp) : null;
  const kpBars = kp
    .map((r) => {
      const s = kpSeverity(r.kp);
      return `<div class="kp-bar ${s.cls}" style="height:${Math.max(6, r.kp * 10)}%"
        title="${r.time.slice(5, 16)}Z — Kp ${r.kp.toFixed(2)} (${s.level})"></div>`;
    })
    .join('');

  // ---- aurora × cloud per location (the verified-novel cross)
  const auroraRows = await Promise.all(
    locations.map(async (loc) => {
      const prob = sampleAurora(loc.lat, loc.lon);
      const cloud = prob !== null && prob >= 5 ? await cloudCoverNow(loc) : null;
      if (prob === null) return `<tr><td>${loc.name}</td><td colspan="3">aurora model unavailable</td></tr>`;
      const v = auroraVerdict(prob, cloud ?? 0);
      return `<tr><td>${loc.name}</td>
        <td class="num">${prob}%</td>
        <td class="num">${cloud !== null ? cloud + '%' : '—'}</td>
        <td class="${v.cls}">${v.verdict}</td></tr>`;
    }),
  );

  // ---- station passes per location (ISS/Tiangong × cloud — CelesTrak, cached 6 h)
  const passRows: string[] = [];
  for (const loc of locations) {
    try {
      const sp = await nextVisiblePasses(loc);
      if (sp.length === 0) {
        passRows.push(`<tr><td>${loc.name}</td><td colspan="4" class="muted">no visible pass in the next 48 h — daylight or shadow the whole way</td></tr>`);
        continue;
      }
      for (const x of sp) {
        const p = x.pass;
        const hrs = (p.aosMs - Date.now()) / 3_600_000;
        const inWord = hrs < 1.5 ? `in ${Math.max(1, Math.round(hrs * 60))} min` : `in ${Math.round(hrs)} h`;
        passRows.push(`<tr><td>${loc.name}</td>
          <td>${x.station} · ${new Date(p.aosMs).toISOString().slice(5, 16).replace('T', ' ')}Z (${inWord})</td>
          <td class="num">max ${Math.round(p.maxElevDeg)}° · ${azWord(p.aosAzDeg)}→${azWord(p.losAzDeg)}</td>
          <td class="num">${x.cloudPct !== null ? x.cloudPct + '%' : '—'}</td>
          <td class="${x.verdict.cls}">${x.verdict.verdict}</td></tr>`);
      }
    } catch (err) {
      passRows.push(`<tr><td>${loc.name}</td><td colspan="4" class="muted">pass prediction failed: ${err instanceof Error ? err.message : err}</td></tr>`);
    }
  }

  // ---- balloon truth per location (sequential — SondeHub politeness)
  const balloonRows: string[] = [];
  for (const loc of locations) {
    try {
      const bt = await balloonTruth(loc);
      if (!bt) {
        balloonRows.push(`<tr><td>${loc.name}</td><td colspan="4" class="muted">no sonde within 300 km in the last 12 h</td></tr>`);
        continue;
      }
      const s = bt.sonde;
      const delta =
        bt.deltaC !== null
          ? `<b class="${Math.abs(bt.deltaC) >= 2 ? 'delta-big' : ''}">${bt.deltaC > 0 ? '+' : ''}${bt.deltaC} °C</b>`
          : '—';
      balloonRows.push(`<tr><td>${loc.name}</td>
        <td>${s.serial} (${s.type}) · ${s.distanceKm} km · ${s.ageMin < 90 ? s.ageMin + ' min ago' : Math.round(s.ageMin / 60) + ' h ago'}</td>
        <td class="num">${s.tempC !== null ? s.tempC.toFixed(1) + ' °C' : '—'} @ ${Math.round(s.altM)} m</td>
        <td class="num">${bt.modelTempC !== null ? bt.modelTempC.toFixed(1) + ' °C' : '—'}</td>
        <td class="num">${delta}</td></tr>`);
    } catch (err) {
      balloonRows.push(`<tr><td>${loc.name}</td><td colspan="4" class="muted">sonde lookup failed: ${err instanceof Error ? err.message : err}</td></tr>`);
    }
  }

  dlg.innerHTML = `
    <button class="dialog-close" aria-label="Close">×</button>
    <h2>Atmosphere to space</h2>

    <h3>Solar wind now ${sev ? `· <span class="${sev.cls}">Kp ${latest!.kp.toFixed(1)} — ${sev.level}</span>` : ''}</h3>
    <div id="sw-now" class="sw-row">${wind ? windHtml(wind) : 'solar wind unavailable'}</div>

    <h3>CME watch <span class="kp-note">NASA CCMC / DONKI</span></h3>
    ${cmeHtml}

    <h3>Kp — last 3 days <span class="kp-note">${kpSeries?.sourceLabel ?? ''}${kpSeries?.official ? ' ✓' : ''}</span></h3>
    <div class="kp-strip">${kpBars}</div>

    <h3>Aurora × cloud ${ovationMeta ? `<span class="kp-note">OVATION forecast ${ovationMeta.forecastTime.slice(11, 16)}Z</span>` : ''}</h3>
    <table class="receipts-table"><thead><tr><th>location</th><th>aurora</th><th>cloud</th><th>can you see it?</th></tr></thead>
    <tbody>${auroraRows.join('')}</tbody></table>

    <h3>Stations overhead <span class="kp-note">CelesTrak elements · SGP4 cross-checked vs Skyfield · visible = you dark, station sunlit</span></h3>
    <table class="receipts-table"><thead><tr><th>location</th><th>next visible pass</th><th>track</th><th>cloud</th><th>go out?</th></tr></thead>
    <tbody>${passRows.join('')}</tbody></table>

    <h3>Balloon truth <span class="kp-note">SondeHub (CC BY-SA 2.0) — sonde and model shown side by side, never blended</span></h3>
    <table class="receipts-table"><thead><tr><th>location</th><th>nearest sonde</th><th>sonde measured</th><th>model says</th><th>Δ</th></tr></thead>
    <tbody>${balloonRows.join('')}</tbody></table>`;

  dlg.querySelector('.dialog-close')?.addEventListener('click', () => {
    stopSpacePolling();
    dlg.close();
  });

  // Repoll ONLY the 60-byte summaries, only while open.
  stopSpacePolling();
  pollTimer = window.setInterval(() => {
    if (!dlg.open) return stopSpacePolling();
    void fetchSolarWindNow()
      .then((w) => {
        const el = dlg.querySelector('#sw-now');
        if (el) el.innerHTML = windHtml(w);
      })
      .catch(() => undefined);
  }, 60_000);
}
