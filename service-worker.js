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

const CACHE_VERSION = "reunly-v34";
const SHELL = [
  "index.html",
  "styles.css",
  "data.js",
  "engine.js",
  "fares.js",
  "globe-land.js",
  "app.js",
  "manifest.json",
  "icon.svg",
];

self.addEventListener("install", (event) => {
  // Per-file, not addAll: addAll is atomic, so one 404 on any shell file threw
  // away the whole precache and left the app with no offline support at all —
  // silently, because nothing surfaces an install failure to the user.
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) =>
        Promise.all(
          SHELL.map((file) =>
            cache.add(file).catch((err) => {
              console.warn(`[sw] could not precache ${file}`, err);
            })
          )
        )
      )
      .then(() => self.skipWaiting())
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
  // Video is fetched in byte ranges (206), which the Cache API can't store;
  // let the browser stream it straight from the network.
  if (url.pathname.startsWith("/media/")) return;

  const isNavigation =
    event.request.mode === "navigate" || event.request.destination === "document";

  // Network-first: fetch fresh, update cache, fall back to cache when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // Only cache real successes. A transient 502 from the host used to be
        // written into the cache and then served as the offline fallback
        // indefinitely — the app would keep showing an error page long after
        // the server recovered.
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(event.request);
        if (hit) return hit;
        // A miss used to resolve to undefined, which respondWith turns into an
        // opaque network error — a blank tab with no explanation. Offline
        // navigations get the cached shell instead; the app runs from
        // localStorage, so it is genuinely usable.
        if (isNavigation) {
          const shell = await caches.match("index.html");
          if (shell) return shell;
        }
        return new Response("Offline and not cached.", {
          status: 503,
          statusText: "Offline",
          headers: { "Content-Type": "text/plain" },
        });
      })
  );
});
