/**
 * Offline support.
 *
 * The app is a handful of static files and all game data lives in
 * localStorage, so caching the shell is enough to make it work with no
 * signal - which is the normal state of a kitchen table full of people.
 */

const CACHE = 'poker-manager-v6';

const SHELL = [
  '.',
  'index.html',
  'styles.css',
  'app.js',
  'src/engine.js',
  'src/store.js',
  'src/sync.js',
  'src/vision.js',
  'src/table-watch.js',
  'src/deck.js',
  'manifest.webmanifest',
  'fonts/assistant-hebrew.woff2',
  'fonts/assistant-latin.woff2',
  'fonts/frank-ruhl-libre-hebrew.woff2',
  'fonts/frank-ruhl-libre-latin.woff2',
  'fonts/suez-one-hebrew.woff2',
  'fonts/suez-one-latin.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  // Network first so a deploy is picked up promptly, cache as the fallback.
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() =>
        caches.match(request).then((hit) => hit || caches.match('index.html'))
      )
  );
});
