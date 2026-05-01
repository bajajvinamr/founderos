const CACHE_NAME = "founderos-shell-v2";
const PRECACHE = [
  "/",
  "/index.html",
  "/favicon.svg",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache API requests
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Network-first for page navigations — always get fresh HTML
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .catch(() => caches.match("/index.html").then(r => r || caches.match("/")))
    );
    return;
  }

  // Only cache non-hashed static assets (fonts, images, manifests).
  // JS/CSS bundles have content hashes in their filenames — the browser's
  // native HTTP cache handles them correctly. Caching them in the SW causes
  // stale-bundle bugs when the SW cache name doesn't change between deploys.
  const isHashedBundle = /\.(js|css)$/.test(url.pathname) && /[A-Za-z0-9_-]{8,}\./.test(url.pathname);
  if (isHashedBundle) {
    return;
  }

  if (["font", "image"].includes(request.destination)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return res;
        });
      })
    );
  }
});
