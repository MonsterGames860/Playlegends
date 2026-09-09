// ============= LEGENDS CORE EDITION SERVICE WORKER (sw2) =============
// Otomatik güncelleme ve caching stratejisi
// .js, .json, .png, .html, .mp3 dosyaları otomatik güncellenir
// Yeni deploy algılanırsa sayfa 1 kez yenilenir

const CACHE_VERSION = 'legends-ce-v' + new Date().getTime();
const RUNTIME_CACHE = 'legends-ce-runtime';
const DEPLOY_VERSION_KEY = 'legends-ce-deploy-version';
const PAGE_REFRESH_KEY = 'legends-ce-page-refreshed';

// Güncellenebilir dosya türleri
const UPDATABLE_EXTENSIONS = ['.js', '.json', '.png', '.html', '.mp3'];

// ============= INSTALL EVENT =============
self.addEventListener('install', (event) => {
  console.log('🔧 Service Worker (sw2) installing...');
  
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      console.log('📦 Service Worker (sw2) cache created');
      return Promise.resolve();
    })
  );
  
  self.skipWaiting();
});

// ============= ACTIVATE EVENT =============
self.addEventListener('activate', (event) => {
  console.log('✅ Service Worker (sw2) activating...');
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_VERSION && cacheName !== RUNTIME_CACHE) {
            console.log('🗑️ Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  
  self.clients.claim();
  
  // Yeni SW kuruldu - sayfa yenileme flag'ını kontrol et
  console.log('🔄 New SW activated - checking if page needs refresh...');
  self.clients.matchAll().then((clients) => {
    clients.forEach((client) => {
      client.postMessage({
        type: 'NEW_SW_ACTIVATED',
        shouldRefresh: true
      });
    });
  });
});

// ============= YARDIMCI FONKSIYON =============
function isUpdatableFile(url) {
  const pathname = new URL(url).pathname;
  return UPDATABLE_EXTENSIONS.some(ext => pathname.endsWith(ext));
}

// ============= FETCH EVENT - SMART CACHING =============
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  if (request.method !== 'GET') {
    return;
  }
  
  // Dış kaynaklar için network-first
  if (url.hostname !== location.hostname) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          return response;
        })
        .catch(() => {
          return caches.match(request);
        })
    );
    return;
  }
  
  // Kendi dosyalarımız - güncellenebilir dosyalar
  if (isUpdatableFile(request.url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => {
              cache.put(request, responseClone);
              console.log('✅ Cached (LATEST):', request.url);
            });
          }
          return response;
        })
        .catch(() => {
          return caches.match(request).then((cachedResponse) => {
            if (cachedResponse) {
              console.log('📦 Serving from cache:', request.url);
              return cachedResponse;
            }
            return new Response('Offline - File not found', { status: 404 });
          });
        })
    );
  } else {
    // Diğer dosyalar için cache-first
    event.respondWith(
      caches.match(request)
        .then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          
          return fetch(request).then((response) => {
            if (response.ok) {
              const responseClone = response.clone();
              caches.open(RUNTIME_CACHE).then((cache) => {
                cache.put(request, responseClone);
              });
            }
            return response;
          });
        })
        .catch(() => {
          return new Response('Offline', { status: 503 });
        })
    );
  }
});

// ============= MESSAGE EVENT - GÜNCELLEME KONTROLÜ =============
self.addEventListener('message', (event) => {
  const { type } = event.data;
  
  if (type === 'SKIP_WAITING') {
    console.log('🔄 Skipping waiting and claiming clients...');
    self.skipWaiting();
  }
  
  // Client tarafından sayfa refresh'i onaylandıysa
  if (type === 'PAGE_REFRESHED') {
    console.log('✅ Page has been refreshed - new SW is active');
    // Sonraki açılışlarda yenileme yapılmayacak
  }
});

console.log('🎮 Legends CE Service Worker (sw2) loaded - Auto-refresh on new deploy');
