/**
 * service-worker.js — offline cache for the Reunly prototype.
 *
 * Strategy: NETWORK-FIRST for the app shell — always try the network so the
 * latest code loads when online, falling back to the cache when offline. This
 * avoids the classic "stale cached JS" trap during development while still
 * giving full offline support. The fare API (/api/) is never cached.
 *
 * Bump CACHE_VERSION whenever shell files change.
 */

const CACHE_VERSION = "reunly-v27";
const SHELL = [
  "index.html",
  "styles.css",
  "data.js",
  "engine.js",
  "fares.js",
  "app.js",
  "manifest.json",
  "icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // fares stay live

  // Network-first: fetch fresh, update cache, fall back to cache when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
