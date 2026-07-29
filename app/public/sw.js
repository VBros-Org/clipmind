const SHELL_CACHE = "clipmind-shell-v1";
const STATIC_CACHE = "clipmind-static-v1";
const DATA_CACHE = "clipmind-data-v1";
const PRECACHE_URLS = [
  "/",
  "/login",
  "/home",
  "/upload",
  "/review",
  "/rhythm",
  "/manifest.webmanifest",
  "/icons/clipmind-192.png",
  "/icons/clipmind-512.png",
  "/icons/clipmind-maskable-512.png"
];

try {
  importScripts("/firebase-messaging-sw.js");
} catch (error) {
  console.error("Firebase messaging import failed", error);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(cleanOldCaches());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (isMediaRequest(request)) {
    return;
  }

  if (isApiOrDataRequest(request, url)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  if (isStaticRequest(request, url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openNotificationTarget(event.notification.data?.url));
});

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);

  await Promise.allSettled(
    PRECACHE_URLS.map(async (url) => {
      const response = await fetch(url, {
        cache: "reload",
        credentials: "same-origin"
      });

      if (response.ok && !response.redirected) {
        await cache.put(url, response.clone());
      }
    })
  );

  await self.skipWaiting();
}

async function cleanOldCaches() {
  const allowedCaches = new Set([SHELL_CACHE, STATIC_CACHE, DATA_CACHE]);
  const names = await caches.keys();

  await Promise.all(
    names
      .filter((name) => !allowedCaches.has(name))
      .map((name) => caches.delete(name))
  );

  await self.clients.claim();
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  await putIfCacheable(request, response, cacheName);
  return response;
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    await putIfCacheable(request, response, cacheName);
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }

    throw error;
  }
}

async function putIfCacheable(request, response, cacheName) {
  if (!response.ok || response.redirected) {
    return;
  }

  const cache = await caches.open(cacheName);
  await cache.put(request, response.clone());
}

function isApiOrDataRequest(request, url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_next/data/") ||
    url.searchParams.has("_rsc") ||
    request.headers.get("accept")?.includes("text/x-component") === true
  );
}

function isStaticRequest(request, url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest" ||
    ["font", "image", "script", "style"].includes(request.destination)
  );
}

function isMediaRequest(request) {
  return ["audio", "video"].includes(request.destination);
}

async function openNotificationTarget(rawUrl) {
  const targetUrl = normalizeNotificationUrl(rawUrl);
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });

  for (const client of windows) {
    const clientUrl = new URL(client.url);
    if (clientUrl.origin !== self.location.origin) {
      continue;
    }

    if ("navigate" in client) {
      await client.navigate(targetUrl.href);
    }
    return client.focus();
  }

  return self.clients.openWindow(targetUrl.href);
}

function normalizeNotificationUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || "/home", self.location.origin);
    if (url.origin === self.location.origin) {
      return url;
    }
  } catch (error) {
    return new URL("/home", self.location.origin);
  }

  return new URL("/home", self.location.origin);
}
