/* WigsStock service worker – offline shell, network-first so updates land */
const CACHE = 'wigsstock-v24';

self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './zxing.min.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './wigsstock.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin) {
    // Core app files (the HTML shell + code + styles) are ALWAYS fetched fresh
    // with cache:'no-store', bypassing the browser's HTTP cache entirely — this
    // is what stops the app getting "stuck" on an old version after a deploy.
    // Cache is only a fallback for offline. Everything else same-origin (zxing,
    // icons — big and rarely change) is cache-first.
    const isCore = req.mode === 'navigate' ||
      url.pathname.endsWith('/') ||
      /\/(index\.html|app\.js|styles\.css)$/.test(url.pathname);
    if (isCore) {
      e.respondWith(
        fetch(req, { cache: 'no-store' }).then((r) => {
          if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return r;
        }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
      );
    } else {
      e.respondWith(
        caches.match(req).then((hit) => hit || fetch(req).then((r) => {
          if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return r;
        }))
      );
    }
    return;
  }

  // Cross-origin (e.g. fonts): cache-first.
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
