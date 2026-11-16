// Offline shell for the app. Screens and their JS/CSS are served from the
// cache first so the app opens and navigates with zero signal; app data is
// handled separately in IndexedDB (src/lib/offline.ts + src/lib/sync.ts).

const CACHE_VERSION = "v5";
const SHELL_CACHE = `shell-${CACHE_VERSION}`;
const STATIC_CACHE = `static-${CACHE_VERSION}`;
const FONT_CACHE = `fonts-${CACHE_VERSION}`;

// Every screen, cached while there's signal. Workout/run screens take their
// id from the query string, so one cached copy serves every workout.
const SHELL_ROUTES = [
  "/",
  "/workout",
  "/workout/summary",
  "/run",
  "/history",
  "/library",
  "/insights",
];

const STATIC_EXTENSIONS = /\.(js|css|svg|png|jpg|jpeg|webp|ico|woff2?)$/;
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];
const RSC_TIMEOUT_MS = 4000;
const PAGE_TIMEOUT_MS = 8000;

// Set when a request recently failed (or the app reports no signal), so
// navigations skip straight to the cache instead of waiting on a dead network.
let networkBadUntil = 0;

function markNetwork(ok) {
  networkBadUntil = ok ? 0 : Date.now() + 20000;
}

function networkLooksDead() {
  return !self.navigator.onLine || Date.now() < networkBadUntil;
}

self.addEventListener("install", (event) => {
  event.waitUntil(warmShell().catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => ![SHELL_CACHE, STATIC_CACHE, FONT_CACHE].includes(k))
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "warm") {
    event.waitUntil(warmShell(Array.isArray(data.urls) ? data.urls : []).catch(() => {}));
  } else if (data.type === "network") {
    markNetwork(!!data.ok);
  }
});

// Only real, signed-in pages — never a redirect to /login or an error page
function isCacheablePage(res) {
  return (
    res &&
    res.ok &&
    !res.redirected &&
    res.type === "basic" &&
    (res.headers.get("content-type") || "").includes("text/html")
  );
}

// JS/CSS/font URLs referenced by a page (script tags, the inline RSC
// payload) or a stylesheet (url(...) fonts). Chunk paths can contain route
// groups like "app/(app)/page-x.js", so parens are allowed.
function extractAssets(text) {
  const urls = new Set();
  const re = /(?:\/_next\/)?static\/(?:chunks|css|media)\/[^"'\s\\<>]+/g;
  let m;
  while ((m = re.exec(text))) {
    let path = m[0];
    // Drop the closing paren of a CSS url(...) wrapper
    while (
      path.endsWith(")") &&
      (path.match(/\)/g) || []).length > (path.match(/\(/g) || []).length
    ) {
      path = path.slice(0, -1);
    }
    urls.add(path.startsWith("/_next/") ? path : `/_next/${path}`);
  }
  return urls;
}

/** Cache each asset; returns further assets found inside stylesheets. */
async function cacheAssets(urls) {
  const statics = await caches.open(STATIC_CACHE);
  const found = new Set();
  await Promise.all(
    [...urls].map(async (url) => {
      try {
        let res = await statics.match(url);
        if (!res) {
          res = await fetch(url);
          if (!res.ok) return;
          await statics.put(url, res.clone());
        }
        if (new URL(url, self.location.origin).pathname.endsWith(".css")) {
          for (const u of extractAssets(await res.text())) {
            if (!urls.has(u)) found.add(u);
          }
        }
      } catch {}
    })
  );
  return found;
}

/**
 * Cache every screen and everything it needs. `loaded` is what the open
 * page already fetched before this worker controlled it.
 */
async function warmShell(loaded = []) {
  const shell = await caches.open(SHELL_CACHE);
  const assets = new Set(
    loaded.filter((u) => new URL(u, self.location.origin).pathname.startsWith("/_next/static/"))
  );
  await Promise.all(
    SHELL_ROUTES.map(async (path) => {
      try {
        const res = await fetch(path, { credentials: "same-origin", cache: "no-store" });
        if (!isCacheablePage(res)) return;
        const html = await res.clone().text();
        await shell.put(path, res);
        for (const url of extractAssets(html)) assets.add(url);
      } catch {}
    })
  );
  const nested = await cacheAssets(assets);
  if (nested.size) await cacheAssets(nested);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request, FONT_CACHE));
    return;
  }

  // Supabase and other APIs go straight to the network; the app handles
  // offline for data itself (and caching auth'd API responses here risks
  // serving stale PR data to the sync engine).
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/login") ||
    url.pathname === "/sw.js"
  ) {
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || STATIC_EXTENSIONS.test(url.pathname)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Client-side navigation payloads. If they can't load, Next falls back to
  // a full page load, which the navigation handler serves from the cache.
  if (request.headers.get("RSC") === "1" || url.searchParams.has("_rsc")) {
    event.respondWith(rscRequest(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(navigation(event, url));
    return;
  }

  event.respondWith(staleWhileRevalidate(event, request, STATIC_CACHE));
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

async function rscRequest(request) {
  if (networkLooksDead()) return new Response("", { status: 503 });
  try {
    const res = await withTimeout(fetch(request), RSC_TIMEOUT_MS);
    markNetwork(true);
    return res;
  } catch {
    markNetwork(false);
    return new Response("", { status: 503 });
  }
}

const LEGACY_ROUTE = /^\/(workout|run)\/([0-9a-f-]{36})(\/summary)?\/?$/i;

async function navigation(event, url) {
  // Old /workout/<id> links → /workout?id=<id> (the server does this too)
  const legacy = url.pathname.match(LEGACY_ROUTE);
  if (legacy) {
    const [, kind, id, summary] = legacy;
    const target = new URL(`/${kind}${summary ? "/summary" : ""}`, url.origin);
    url.searchParams.forEach((v, k) => target.searchParams.set(k, v));
    target.searchParams.set("id", id);
    return Response.redirect(target.href, 302);
  }

  const key = url.pathname.replace(/\/+$/, "") || "/";
  const shell = await caches.open(SHELL_CACHE);
  const cached = await shell.match(key);

  const network = networkLooksDead() && cached
    ? Promise.resolve(null)
    : withTimeout(fetch(event.request), cached ? 30000 : PAGE_TIMEOUT_MS)
        .then(async (res) => {
          markNetwork(true);
          if (isCacheablePage(res)) await shell.put(key, res.clone());
          return res;
        })
        .catch(() => {
          markNetwork(false);
          return null;
        });

  // Cached copy renders instantly; the fresh one replaces it for next time
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  const res = await network;
  if (res) return res;
  const home = await shell.match("/");
  return (
    home ||
    new Response("<h1>Offline</h1><p>Open the app once with signal to use it offline.</p>", {
      status: 503,
      headers: { "Content-Type": "text/html" },
    })
  );
}

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

async function staleWhileRevalidate(event, request, cacheName) {
  const cached = await caches.match(request);
  const refresh = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(cacheName);
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  return (await refresh) || new Response("Offline", { status: 503 });
}
