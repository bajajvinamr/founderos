const CACHE_NAME = "founderos-shell-v1";
const PRECACHE = [
  "/",
  "/index.html",
  "/dashboard",
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
  const url = new URL(event.request.url);

  // Never cache API requests
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Network-first with cache fallback for page navigations
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .catch(() => caches.match("/index.html") || caches.match("/"))
    );
    return;
  }

  // Stale-while-revalidate for static assets
  if (["script", "style", "font", "image"].includes(event.request.destination)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const network = fetch(event.request).then((res) => {
          if (res.ok) {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
