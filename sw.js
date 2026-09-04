// GENERATED from parts/sw.js — do not edit.
// The cache name carries the build stamp, so a new build can never be
// served from an old cache. That was the failure mode worth designing out:
// a phone showing yesterday's app with no way to tell.
// Service worker — network-first so the app always loads the newest version
// when online, but still works offline from cache. Network-first avoids the
// classic "stale PWA won't update" trap.
const CACHE = 'b7k-417217e';
const ASSETS = [
  './index.html',
  './wsola-worklet.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(r => {
          if (r) return r;
          // Fall back to the app shell ONLY for navigations. Doing it for every
          // request hands the HTML page back when a .js is missing — which
          // surfaces as "Unable to load a worklet's module" and points nowhere
          // useful. Let a missing asset fail as a missing asset.
          if (req.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        })
      )
  );
});
