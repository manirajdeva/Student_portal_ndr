// Minimal service worker — required for PWA installability, but this
// app needs live server data on every screen, so it deliberately does
// no offline caching. It just passes every request straight through.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});