// Cache-first app shell + capped runtime cache for map/DEM tiles.
const SHELL = 'shell-v1';
const TILES = 'tiles-v1';
const TILE_CAP = 600;

self.addEventListener('install', (e) => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isTile = (url) =>
  url.hostname === 's3.amazonaws.com' ||
  url.hostname.endsWith('openfreemap.org');

async function cappedPut(cacheName, req, res, cap) {
  const cache = await caches.open(cacheName);
  await cache.put(req, res);
  const keys = await cache.keys();
  if (keys.length > cap) await Promise.all(keys.slice(0, keys.length - cap).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  if (isTile(url)) {
    // stale-while-revalidate for tiles
    e.respondWith(
      caches.match(e.request).then((hit) => {
        const fetched = fetch(e.request)
          .then((res) => {
            if (res.ok) cappedPut(TILES, e.request, res.clone(), TILE_CAP);
            return res;
          })
          .catch(() => hit);
        return hit || fetched;
      }),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    if (e.request.mode === 'navigate') {
      // network-first for the HTML document: a redeploy must never strand
      // users on a stale index that references dead hashed chunks
      e.respondWith(
        fetch(e.request)
          .then((res) => {
            if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
            return res;
          })
          .catch(() => caches.match(e.request)),
      );
      return;
    }
    // cache-first for hashed assets (immutable by construction)
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
            return res;
          }),
      ),
    );
  }
});
