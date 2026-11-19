/**
 * His website as an app (a phone's Home Screen, the user's ask 2026-11-18): when his server can't be reached
 * (Tailscale off on this device, or the server down), a page that says so, instead of the browser's own error.
 *
 * Nothing of his is kept: only that page and its icon are, and everything else goes straight to the server, as it
 * would with no worker at all. His socket isn't a worker's to see.
 */

const CACHE = 'jester-offline-1';
const OFFLINE = '/web/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([OFFLINE, '/web/icons/apple-touch-icon.png']))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

// Only pages opened: a script, a picture or a message is the server's to answer, or to fail.
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});
