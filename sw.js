// Offline support: the app shell is network-first (so updates arrive), CDN libraries are
// cache-first (their URLs are pinned to versions). The voice model caches itself.
const SHELL = 'narrate-shell-v1';
const LIBS = 'narrate-libs-v1';
const SHELL_FILES = [
  './', 'index.html', 'app.js', 'worker.js', 'textproc.js', 'importers.js', 'audio.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('narrate-') && key !== SHELL && key !== LIBS) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req, { ignoreSearch: true })) || (await caches.match('index.html')) || Response.error();
      }
    })());
    return;
  }

  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) (await caches.open(LIBS)).put(req, res.clone());
      return res;
    })());
  }
});
