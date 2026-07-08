// Minimal service worker — exists so the app is installable as a PWA.
// No caching strategy yet: every request passes through to the network.
// Avoids stale-content footguns during active development.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Pass-through. We don't intercept anything yet.
  event.respondWith(fetch(event.request));
});
