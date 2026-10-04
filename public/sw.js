/**
 * Aether service worker — deliberately small, deliberately runtime-only.
 *
 * No build-time precache manifest (and therefore no workbox dependency): Vite hashes asset
 * filenames, so instead of generating a list at build time, the worker caches same-origin
 * responses as they are first fetched. Hashed assets are immutable → cache-first. Navigations
 * are network-first with a cached-shell fallback, which is what makes a fresh offline boot
 * open at all.
 *
 * What it does NOT cache, on purpose:
 *  - api.open-meteo.com — forecast persistence lives in IndexedDB where the app can show its
 *    age honestly; an HTTP cache would silently serve stale JSON as if it were fresh.
 *  - basemap tiles — an unbounded, multi-MB cache. Offline cartography is P6's bundled
 *    PMTiles, not an accidental tile hoard.
 */

// v2: cache name bumped to evict every v1 cache. v1 had a real bug found during P4: it
// cache-first'd ALL same-origin assets, but only Vite's /assets/* files are content-hashed
// and immutable — in dev that meant /src/main.ts was served stale from cache on every fresh
// reload, silently pinning the app to an old build while HMR masked it during editing.
// Cache-first is a claim about immutability; make it only where the filename proves it.
const CACHE = 'aether-shell-v2';

// Vite names build assets `name-HASH.ext`. Every release adds new files and, because assets are
// cache-first, nothing ever removed the old ones: measured 2026-10-03, a phone installed since
// August held six superseded main-*.js/css builds beside the current one.
const ASSET_RE = /^(.*)-([A-Za-z0-9_-]{8})\.([A-Za-z0-9]+)$/;
const assetName = (u) => new URL(u, self.location.href).pathname.split('/assets/')[1] ?? null;
const family = (file) => {
  const m = ASSET_RE.exec(file);
  return m ? `${m[1]}.${m[3]}` : null;
};

/**
 * After a fresh page load, drop cached assets that a current entry has superseded: same name
 * and extension, different hash. The current set comes from the page just fetched, so this
 * never removes anything the live build needs. Lazily loaded chunks the page does not name
 * are left alone — evicting by guess could break an offline feature, and a stale chunk costs
 * kilobytes, not a release's worth of bundle.
 */
async function pruneSuperseded(html) {
  const current = new Set([...html.matchAll(/assets\/[^"'\s>]+/g)].map((m) => assetName(m[0])));
  current.delete(null);
  if (!current.size) return; // an unexpected page must never trigger deletions
  const families = new Set([...current].map(family).filter(Boolean));
  const cache = await caches.open(CACHE);
  for (const req of await cache.keys()) {
    const file = assetName(req.url);
    if (!file || current.has(file)) continue;
    const fam = family(file);
    if (fam && families.has(fam)) await cache.delete(req);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Cross-origin: never intercepted. See header for why.
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  // Navigations: network-first, cached shell as the offline fallback.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
          if (res.ok) event.waitUntil(res.clone().text().then(pruneSuperseded).catch(() => undefined));
          return res;
        })
        .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match('./'))),
    );
    return;
  }

  // Hashed build assets ONLY: cache-first, because the hash in the name proves immutability.
  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ??
          fetch(event.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(event.request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Everything else same-origin (manifest, icons, wind texture, dev module URLs):
  // network-first with cache fallback — fresh when online, still present offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? Response.error())),
  );
});
