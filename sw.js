const CACHE_NAME = 'seeker-camera-v11';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/script.js',
  '/manifest.json',
  '/watermark.png',
  '/preview-v2.png',
  '/icons/camcorder_line.svg',
  '/icons/camcorder_off_line.svg',
  '/icons/camera_2_ai_line.svg',
  '/icons/close_line.svg',
  '/icons/download_2_line.svg',
  '/icons/mirror_line.svg',
  '/icons/play_circle_fill.svg',
  '/icons/social_x_line.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      // Return cached version if found, else fetch from network
      return response || fetch(event.request).catch(() => {
        // Optional: Return a fallback offline page if network fails
      });
    })
  );
});
