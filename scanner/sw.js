const CACHE_NAME = 'qr-scanner-v1';
const assets = [
  './index.html',
  './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(assets))
  );
});

self.addEventListener('fetch', e => {
  // On laisse passer les requêtes fetch vers l'URL paramétrable du serveur, et on met en cache le reste
  if (e.request.url.includes(location.origin)) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});