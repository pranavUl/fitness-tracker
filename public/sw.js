const CACHE_VERSION = "v4";
const MAX_DYNAMIC_ENTRIES = 60;
const STATIC_CACHE = `static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `dynamic-${CACHE_VERSION}`;
const FONT_CACHE = `fonts-${CACHE_VERSION}`;

const PRECACHE_URLS = ["/", "/history", "/library", "/insights"];

const STATIC_EXTENSIONS = /\.(js|css|svg|png|jpg|jpeg|webp|ico|woff2?)$/;
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];
const SUPABASE_PATTERN = /\.supabase\.co\//;
const AUTH_PATTERNS = ["/auth/", "/token"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter(
            (k) => k !== STATIC_CACHE && k !== DYNAMIC_CACHE && k !== FONT_CACHE
          )
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") return;

  if (AUTH_PATTERNS.some((p) => url.pathname.includes(p))) return;

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request, FONT_CACHE));
    return;
  }

  if (STATIC_EXTENSIONS.test(url.pathname) || url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (SUPABASE_PATTERN.test(url.href)) {
    event.respondWith(networkFirst(request, DYNAMIC_CACHE, 6000));
    return;
  }

  if (url.origin === self.location.origin) {
    // Pages: serve from cache instantly, refresh the cache in the background.
    // App data freshness is handled at the app layer (IndexedDB snapshots),
    // so a slightly stale HTML shell is always safe and always fast.
    event.respondWith(staleWhileRevalidate(request, DYNAMIC_CACHE));
    return;
  }
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response("Offline", { status: 503 });
  }
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    for (let i = 0; i < keys.length - maxEntries; i++) {
      await cache.delete(keys[i]);
    }
  }
}

function fetchWithTimeout(request, timeoutMs) {
  if (!timeoutMs) return fetch(request);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    fetch(request).then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function networkFirst(request, cacheName, timeoutMs) {
  try {
    const response = await fetchWithTimeout(request, timeoutMs);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
      trimCache(cacheName, MAX_DYNAMIC_ENTRIES);
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.headers.get("accept")?.includes("text/html")) {
      const fallback = await caches.match("/");
      if (fallback) return fallback;
    }
    return new Response("Offline", { status: 503 });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cached = await caches.match(request);

  const refresh = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(cacheName);
        cache.put(request, response.clone());
        trimCache(cacheName, MAX_DYNAMIC_ENTRIES);
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    return cached;
  }

  const fresh = await refresh;
  if (fresh) return fresh;

  if (request.headers.get("accept")?.includes("text/html")) {
    const fallback = await caches.match("/");
    if (fallback) return fallback;
  }
  return new Response("Offline", { status: 503 });
}
