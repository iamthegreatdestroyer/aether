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

const CACHE = 'aether-shell-v1';

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
          return res;
        })
        .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match('./'))),
    );
    return;
  }

  // Same-origin assets: cache-first (Vite-hashed files are immutable), fill on first fetch.
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
});
