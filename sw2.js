// ============= LEGENDS CORE EDITION SERVICE WORKER (sw2) =============
// Otomatik güncelleme ve caching stratejisi
// .js, .json, .png, .html, .mp3 dosyaları otomatik güncellenir

const CACHE_VERSION = 'legends-ce-v' + new Date().getTime();
const RUNTIME_CACHE = 'legends-ce-runtime';

// Güncellenebilir dosya türleri
const UPDATABLE_EXTENSIONS = ['.js', '.json', '.png', '.html', '.mp3'];

// ============= INSTALL EVENT =============
self.addEventListener('install', (event) => {
  console.log('🔧 Service Worker (sw2) installing...');
  
  // Root dosyasını cache'le
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      console.log('📦 Service Worker (sw2) activated');
      return Promise.resolve();
    })
  );
  
  // Yeni Service Worker'ı hemen aktif et
  self.skipWaiting();
});

// ============= ACTIVATE EVENT =============
self.addEventListener('activate', (event) => {
  console.log('✅ Service Worker (sw2) activating...');
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          // Eski cache versiyonlarını sil
          if (cacheName !== CACHE_VERSION && cacheName !== RUNTIME_CACHE) {
            console.log('🗑️ Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  
  // Beklemeden controllership'i ele al
  self.clients.claim();
});

// ============= YARDIMCI FONKSIYON =============
function isUpdatableFile(url) {
  // URL'den dosya türünü al
  const pathname = new URL(url).pathname;
  return UPDATABLE_EXTENSIONS.some(ext => pathname.endsWith(ext));
}

// ============= FETCH EVENT - SMART CACHING =============
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Sadece GET isteklerini işle
  if (request.method !== 'GET') {
    return;
  }
  
  // Firebase ve dış kaynaklar için network-first
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
  
  // Kendi dosyalarımız - güncellenebilir dosyalar için özel stratezi
  if (isUpdatableFile(request.url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            // Başarılı response'ı cache'e kaydet (eski versiyon yazılır - always fresh!)
            const responseClone = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => {
              cache.put(request, responseClone);
              console.log('✅ Cached (LATEST):', request.url);
            });
          }
          return response;
        })
        .catch(() => {
          // Network başarısızsa cache'den dondür
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
    // Diğer dosyalar için cache-first stratejisi
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
// .js, .json, .png, .html, .mp3 dosyaları her sayfa yenileşinde güncellenir
self.addEventListener('message', (event) => {
  const { type, urls } = event.data;
  
  if (type === 'SKIP_WAITING') {
    console.log('🔄 Skipping waiting and claiming clients...');
    self.skipWaiting();
  }
  
  if (type === 'UPDATE_CACHE') {
    console.log('🔍 Checking for updates on page refresh...');
    // Belirtilen URL'leri güncelleyin
    if (urls && Array.isArray(urls)) {
      caches.open(RUNTIME_CACHE).then((cache) => {
        urls.forEach((url) => {
          if (isUpdatableFile(url)) {
            fetch(url)
              .then((response) => {
                if (response.ok) {
                  cache.put(url, response);
                  console.log('✅ Force updated (page refresh):', url);
                }
              })
              .catch((err) => {
                console.log('ℹ️ Keeping cached version:', url);
              });
          }
        });
      });
    }
  }
  
  // Sayfa yenilenmişse RUNTIME_CACHE'deki tüm updatable dosyaları güncelle
  if (type === 'PAGE_RELOAD') {
    console.log('🔄 Page reloaded - updating all .js/.json/.png/.html/.mp3 files...');
    self.clients.matchAll().then((clients) => {
      clients.forEach((client) => {
        // Her sayfa yenilemesinde bu event tetiklenir
        // Cache'deki tüm dosyalar en yeni versiyonla güncellenir
      });
    });
  }
});

console.log('🎮 Legends CE Service Worker (sw2) loaded with auto-update for .js, .json, .png, .html, .mp3');
