// ============= LEGENDS CORE EDITION SERVICE WORKER =============
// Otomatik güncelleme ve caching stratejisi

const CACHE_VERSION = 'legends-ce-v1';
const RUNTIME_CACHE = 'legends-ce-runtime';

// Kaşe edilecek dosyalar (deployment'da güncelle)
const PRECACHE_URLS = [
  './',
  './ce-launcher.html',
  './ce-manifest.json',
  './index.html'
  // Resim ve diğer assetleri ekle
];

// ============= INSTALL EVENT =============
self.addEventListener('install', (event) => {
  console.log('🔧 Service Worker installing...');
  
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      console.log('📦 Precaching files...');
      return cache.addAll(PRECACHE_URLS).catch((error) => {
        console.warn('⚠️ Some files failed to cache:', error);
        // Hata durumunda bile devam et
        return Promise.resolve();
      });
    })
  );
  
  // Yeni Service Worker'ı hemen aktif et
  self.skipWaiting();
});

// ============= ACTIVATE EVENT =============
self.addEventListener('activate', (event) => {
  console.log('✅ Service Worker activating...');
  
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

// ============= FETCH EVENT - NETWORK FIRST STRATEGY =============
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
          // Başarılıysa dondür
          return response;
        })
        .catch(() => {
          // Başarısızsa cache'den dondür
          return caches.match(request);
        })
    );
    return;
  }
  
  // Kendi dosyalarımız için network-first
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Geçerliyse runtime cache'e kaydet
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => {
            cache.put(request, responseClone);
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
          
          // Cache'de de yoksa offline sayfası dondür
          return caches.match('./index.html');
        });
      })
  );
});

// ============= MESSAGE EVENT - GÜNCELLEME KONTROLÜNÜ =============
self.addEventListener('message', (event) => {
  const { type } = event.data;
  
  if (type === 'SKIP_WAITING') {
    console.log('🔄 Skipping waiting and claiming clients...');
    self.skipWaiting();
  }
  
  if (type === 'CHECK_UPDATE') {
    console.log('🔍 Checking for updates...');
    // Client'a güncelleme durumunu gönder
    event.ports[0].postMessage({ type: 'UPDATE_AVAILABLE' });
  }
});

console.log('🎮 Legends CE Service Worker loaded');
