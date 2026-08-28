/**
 * fares.js — client-side fare fetching against the same-origin /api proxy.
 *
 * The engine stays synchronous and offline-capable (engine.getFare gives an
 * immediate searched/estimated answer). This layer asynchronously upgrades that
 * with whatever the backend returns (live/searched/estimated), caches it in
 * memory + localStorage, and notifies the app to re-render.
 *
 * Design: render-now-with-fallback, upgrade-when-ready. Nothing here blocks the
 * first paint, and if the proxy is unreachable the app silently uses local data.
 */

(function () {
  "use strict";

  const STORAGE_KEY = "reunly_fare_cache_v1";
  const TTL_MS = 6 * 60 * 60 * 1000; // re-fetch fares older than 6h
  const cache = new Map(); // "from|to" -> { min, max, currency, source, asOf, fetchedAt }

  // Restore persisted cache (best effort).
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    for (const [k, v] of Object.entries(saved)) cache.set(k, v);
  } catch (e) {
    /* ignore corrupt cache */
  }

  // The date is part of the identity of a fare. Keying on the route alone
  // meant a Christmas quote and an off-season quote for the same city shared
  // one slot, so whichever landed first was reused for every window.
  const key = (from, to, date) => `${from}|${to}|${date || ""}`;

  function persist() {
    try {
      const obj = {};
      cache.forEach((v, k) => (obj[k] = v));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch (e) {
      /* storage full / unavailable — fine */
    }
  }

  function fresh(entry) {
    return entry && entry.fetchedAt && Date.now() - entry.fetchedAt < TTL_MS;
  }

  /**
   * Synchronous read of a cached fare entry, or null if never fetched.
   * NOTE: a resolved-but-unknown city is cached as { source:"unknown" } (no
   * min), so callers can distinguish "pending" (null) from "no estimate".
   */
  function getCached(from, to, date) {
    return cache.get(key(from, to, date)) || null;
  }
  /** Has this route been fetched at all (even if it resolved to unknown)? */
  function isResolved(from, to, date) {
    return cache.has(key(from, to, date));
  }

  /** Fetch one fare from the proxy; resolves to the fare object or null. */
  async function fetchFare(from, to, date, nights) {
    const k = key(from, to, date);
    const existing = cache.get(k);
    if (fresh(existing)) return existing;
    try {
      const qs = new URLSearchParams({
        from, to,
        ...(date ? { date } : {}),
        ...(nights ? { nights: String(nights) } : {}),
      });
      const res = await fetch(`/api/fare?${qs.toString()}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data) {
        // Cache everything, including resolved-but-unknown, so the UI can stop
        // showing a "pending" state. Only fares with a min are usable values.
        data.fetchedAt = Date.now();
        // Which departure this price was actually quoted for. Without it the
        // engine can't tell a Christmas quote from an off-season one and would
        // trust either to already embody its own seasonal pricing.
        data.quotedFor = date || null;
        cache.set(k, data);
        persist();
        return data.min != null ? data : null;
      }
    } catch (e) {
      /* offline or no proxy — caller falls back to engine.getFare */
    }
    return null;
  }

  /**
   * Ensure fares for a set of [from, to] routes are loaded. Calls onUpdate()
   * once after any new data arrives so the app can re-render. Dedupes routes.
   */
  async function ensureFares(routes, onUpdate) {
    const seen = new Set();
    const todo = [];
    for (const [from, to, date, nights] of routes) {
      if (!from || !to) continue;
      const k = key(from, to, date);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!fresh(cache.get(k))) todo.push([from, to, date, nights]);
    }
    if (!todo.length) return;
    const results = await Promise.all(
      todo.map(([f, t, d, n]) => fetchFare(f, t, d, n))
    );
    if (results.some(Boolean) && typeof onUpdate === "function") onUpdate();
  }

  // ---- Destination photos (via /api/photo, cached) ----
  const PHOTO_KEY = "reunly_photo_cache_v1";
  const photos = new Map(); // place -> url (or "" for known-none)
  try {
    const saved = JSON.parse(localStorage.getItem(PHOTO_KEY) || "{}");
    for (const [k, v] of Object.entries(saved)) photos.set(k, v);
  } catch (e) {
    /* ignore */
  }
  function persistPhotos() {
    try {
      const obj = {};
      photos.forEach((v, k) => (obj[k] = v));
      localStorage.setItem(PHOTO_KEY, JSON.stringify(obj));
    } catch (e) {
      /* ignore */
    }
  }
  /** Sync read: undefined = never fetched, "" = none found, string = url. */
  function getCachedPhoto(place) {
    return photos.get(place);
  }
  async function fetchPhoto(place) {
    if (!place) return null;
    if (photos.has(place)) return photos.get(place) || null;
    try {
      const res = await fetch(`/api/photo?place=${encodeURIComponent(place)}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error("photo http");
      const data = await res.json();
      const url = data && data.image ? data.image : "";
      photos.set(place, url);
      persistPhotos();
      return url || null;
    } catch (e) {
      return null;
    }
  }

  window.ReunlyFares = {
    getCached, isResolved, fetchFare, ensureFares, key,
    getCachedPhoto, fetchPhoto,
  };
})();
