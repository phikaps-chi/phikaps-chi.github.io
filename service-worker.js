const CACHE_NAME = 'phi-kap-cache-v1';
const ASSETS = [
  './',
  'index.html',
  'app.html',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  // Take control of all clients as soon as the SW activates
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => {
      // Return from cache if available, otherwise fetch from network
      return cached || fetch(event.request);
    })
  );
});
