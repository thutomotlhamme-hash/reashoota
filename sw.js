// ReaShoota service worker: the app shell is cached so the app opens with no signal.
// Project data and media live in IndexedDB (see src/store.js), not here.

const VERSION = 'reashoota-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './src/app.js',
  './src/project.js',
  './src/sections.js',
  './src/pdf.js',
  './src/pdf-packs.js',
  './src/backup.js',
  './src/store.js',
  './src/share.js',
  './src/images.js',
  './src/video.js',
  './src/offline.js',
  './src/cloud.js',
  './src/exports.js',
  './src/timeline.js',
  './src/audio.js',
  './src/render.js',
  './src/camera.js',
  './src/captions.js',
  './fonts/fonts.css',
  './fonts/Anton-400.woff2',
  './fonts/ArchivoBlack-400.woff2',
  './fonts/BebasNeue-400.woff2',
  './fonts/InstrumentSans.woff2',
  './fonts/InstrumentSerif-400.woff2',
  './fonts/JetBrainsMono.woff2',
  './fonts/PermanentMarker-400.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_SHELL') return;
  const port = event.ports[0];
  event.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL))
    .then(() => port?.postMessage({ ok: true }), () => port?.postMessage({ ok: false })));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cloud API etc. go straight to network

  // Pages: network first so updates arrive, cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put('./index.html', copy));
      return res;
    }).catch(() => caches.match('./index.html', { ignoreSearch: true })));
    return;
  }

  // Static files: serve from cache instantly, refresh in the background.
  event.respondWith(caches.open(VERSION).then(async (cache) => {
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});
