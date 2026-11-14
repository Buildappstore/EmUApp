const SHELL_CACHE = 'shell-v17';
const EJS_CACHE = 'ejs-v1';
const SHELL = ['./', 'index.html', 'play.html', 'api-config.js', 'db.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== EJS_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin && url.pathname.endsWith('/api-config.js')) {
    e.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then(res => {
          if (res.ok) caches.open(SHELL_CACHE).then(c => c.put(req, res.clone()));
          return res;
        })
        .catch(async error => {
          const cached = await caches.match(req, { ignoreSearch: true });
          if (cached) return cached;
          throw error;
        })
    );
    return;
  }

  // Archivos propios de la app: caché primero, actualiza en segundo plano
  if (url.origin === location.origin && !url.pathname.startsWith('/api/')) {
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then(hit => {
        const net = fetch(req).then(res => {
          if (res.ok) caches.open(SHELL_CACHE).then(c => c.put(req, res.clone()));
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // Núcleos de EmulatorJS: se guardan la primera vez que se usan y luego funcionan sin internet
  if (url.hostname === 'cdn.emulatorjs.org') {
    e.respondWith(
      caches.open(EJS_CACHE).then(async c => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      })
    );
  }
});
