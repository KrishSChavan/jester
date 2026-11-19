/**
 * His website as an app (a phone's Home Screen, the user's ask 2026-11-18): when his server can't be reached
 * (Tailscale off on this device, or the server down), a page that says so, instead of the browser's own error.
 *
 * Nothing of his is kept: only that page and its icon are, and everything else goes straight to the server, as it
 * would with no worker at all. His socket isn't a worker's to see.
 *
 * And what he sends this device while his app's closed (main/push.js): shown as a notification, which opens him.
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

// A line from him (push.js), read only here: the push service carried it sealed. Every one is shown, as iPhones ask.
self.addEventListener('push', (event) => {
  let said = {};
  try {
    said = event.data?.json() || {};
  } catch {
    said = { body: event.data?.text() || '' };
  }
  const title = String(said.title || 'Jester');
  event.waitUntil(self.registration.showNotification(title, { body: String(said.body || ''), icon: '/web/icons/icon-192.png', badge: '/web/icons/icon-192.png', ...(said.tag ? { tag: String(said.tag) } : {}), data: { url: '/' } }));
});

// Tapped: his app, brought forward if it's open, opened if not.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((open) => {
      const there = open.find((client) => new URL(client.url).origin === self.location.origin);
      return there ? there.focus() : self.clients.openWindow('/');
    })
  );
});
