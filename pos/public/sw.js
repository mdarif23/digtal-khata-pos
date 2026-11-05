/*
 * ezPos POS app-shell service worker (Phase 3). Deliberately minimal:
 * - same-origin GET static assets (built bundles, fonts, icons): cache-first
 * - everything else (API calls, cross-origin): network only, never cached
 * Transactions live in IndexedDB (the offline engine), NOT here.
 */
const CACHE = "ezpos-shell-v1";

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
  if (!/\.[a-f0-9]{8,}\.|\/assets\/|\.(js|css|woff2?|png|svg|ico|webmanifest)$/.test(url.pathname) && url.pathname !== "/") {
    return;
  }
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(() => caches.match("/index.html"));
    }),
  );
});
