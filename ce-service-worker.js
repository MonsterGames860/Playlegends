const CE_CACHE = 'legends-ce-launcher-v1';

self.addEventListener('install', (event) => {
  // CE Launcher precache
  const precacheUrls = [
    './ce-launcher.html',
    './ce-manifest.json',
    './ce-launcher-logo-192.png',
    './ce-launcher-logo-512.png'
  ];

  event.waitUntil(
    caches.open(CE_CACHE).then((cache) => {
      return Promise.allSettled(
        precacheUrls.map(url => cache.add(url))
      ).then((results) => {
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            console.warn(`Failed to precache: ${precacheUrls[index]}`);
          }
        });
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const isLocalOrigin = url.origin === self.location.origin;

  // CDN kaynakları için: network-first
  if (!isLocalOrigin) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CE_CACHE).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => {
          console.debug(`CDN resource offline: ${event.request.url}`);
          return new Response('', { status: 503 });
        })
    );
    return;
  }

  // Same-origin: cache-first
  event.respondWith(
    caches.match(event.request)
      .then((cached) => {
        if (cached) {
          return cached;
        }
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CE_CACHE).then((cache) => cache.put(event.request, copy));
          }
          return response;
        });
      })
      .catch(() => {
        return caches.match(event.request)
          .then((cached) => cached || new Response('Offline', { status: 503 }));
      })
  );
});
