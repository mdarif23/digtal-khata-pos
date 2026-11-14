/*
 * ezPos POS app-shell service worker (Phase 3). Deliberately minimal:
 * - navigations ("/", "/index.html"): NETWORK-FIRST — a reload always shows
 *   the current app; the cached shell is only the offline fallback.
 * - hashed build assets (/assets/*, content-hashed filenames): cache-first —
 *   immutable, new name on every build, safe to cache forever.
 * - everything else (dev modules under /src/, config.js, API calls,
 *   cross-origin): network only, never cached.
 * Transactions live in IndexedDB (the offline engine), NOT here.
 *
 * v2: v1 cached ANY .js/.css cache-first (including dev modules under /src/)
 * with an unversioned cache, which froze the UI on the first-ever loaded
 * stylesheet — token/redesign changes never reached browsers until the cache
 * was manually cleared.
 */
const CACHE = "ezpos-shell-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(["/", "/index.html"]).catch(() => undefined)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api")) return;

  // Navigations always revalidate; the cache only saves us when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE)
              .then((cache) => cache.put(request, copy))
              .catch(() => undefined);
          }
          return response;
        })
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached ?? caches.match("/index.html")),
        ),
    );
    return;
  }

  // Immutable hashed build output only. Never cache unhashed files — that is
  // how a redesign previously got stuck serving an old stylesheet.
  const isHashedAsset =
    url.pathname.startsWith("/assets/") || /\.[a-f0-9]{8,}\./.test(url.pathname);
  if (!isHashedAsset) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE)
            .then((cache) => cache.put(request, copy))
            .catch(() => undefined);
        }
        return response;
      });
    }),
  );
});
