// Offline support: the app shell is network-first (so updates arrive), CDN libraries are
// cache-first (their URLs are pinned to versions). The voice model caches itself.
//
// On computers, same-origin responses also get cross-origin isolation headers. GitHub Pages
// can't set headers, and isolation is what lets the voice model use several processor threads.
// "credentialless" keeps CDN and model downloads working without them opting in. iPhones are
// left alone: Safari doesn't support it, and the phone path is tuned for low memory.
const SHELL = 'narrate-shell-v2';
const LIBS = 'narrate-libs-v1';
const SHELL_FILES = [
  './', 'index.html', 'app.js', 'worker.js', 'textproc.js', 'importers.js', 'audio.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const ua = self.navigator.userAgent || '';
const ISOLATE = !/iPhone|iPad|iPod/.test(ua);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL)
    .then((c) => c.addAll(SHELL_FILES).catch(() => c.addAll(SHELL_FILES.filter((f) => !f.startsWith('icons/')))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('narrate-') && key !== SHELL && key !== LIBS) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

function isolate(res) {
  if (!ISOLATE || !res || res.type === 'opaque' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
        return isolate(res);
      } catch {
        const cached = (await caches.match(req, { ignoreSearch: true })) || (await caches.match('index.html'));
        return cached ? isolate(cached) : Response.error();
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
