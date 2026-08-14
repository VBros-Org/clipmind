importScripts("/sw-helpers.js");

const {
  PUBLIC_CACHE,
  PRECACHE_URLS,
  cachePolicy,
  isResponseCacheable,
  navigationFallbacks,
  notificationTargetHref,
  shouldSkipNotificationWindow
} = self.ClipMindPwa;

const uploadingClientIds = new Set();

try {
  importScripts("/firebase-messaging-sw.js");
} catch (error) {
  console.error("Firebase messaging import failed", error);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precachePublicAssets());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(cleanOldCaches());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "clipmind-upload-state") {
    return;
  }

  const clientId = event.source?.id;
  if (!clientId) {
    return;
  }

  if (data.uploadInProgress === true) {
    uploadingClientIds.add(clientId);
  } else {
    uploadingClientIds.delete(clientId);
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const policy = cachePolicy(contextForRequest(request));

  if (policy === "public-cache") {
    event.respondWith(cacheFirstPublicAsset(request));
    return;
  }

  if (policy === "navigation") {
    event.respondWith(networkNavigation(request));
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openNotificationTarget(event.notification.data?.url));
});

async function precachePublicAssets() {
  const cache = await caches.open(PUBLIC_CACHE);

  await Promise.allSettled(
    PRECACHE_URLS.map(async (url) => {
      const request = new Request(url, {
        cache: "reload",
        credentials: "same-origin"
      });
      const response = await fetch(request);

      if (isResponseCacheable(contextForRequest(request), responseSummary(response))) {
        await cache.put(url, response.clone());
      }
    })
  );

  await self.skipWaiting();
}

async function cleanOldCaches() {
  const names = await caches.keys();

  await Promise.all(
    names
      .filter((name) => name !== PUBLIC_CACHE)
      .map((name) => caches.delete(name))
  );

  await self.clients.claim();
}

async function cacheFirstPublicAsset(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  await putIfPublicCacheable(request, response);
  return response;
}

async function networkNavigation(request) {
  try {
    return await fetch(request);
  } catch (error) {
    return offlineNavigationFallback(request);
  }
}

async function offlineNavigationFallback(request) {
  for (const fallback of navigationFallbacks(contextForRequest(request))) {
    const cached = await caches.match(fallback.url, {
      ignoreSearch: fallback.ignoreSearch
    });
    if (cached) {
      return cached;
    }
  }

  return new Response("ClipMind is offline. Reconnect to open your workspace.", {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}

async function putIfPublicCacheable(request, response) {
  if (!isResponseCacheable(contextForRequest(request), responseSummary(response))) {
    return;
  }

  const cache = await caches.open(PUBLIC_CACHE);
  await cache.put(request, response.clone());
}

async function openNotificationTarget(rawUrl) {
  const targetHref = notificationTargetHref(rawUrl, self.location.origin);
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });

  for (const client of windows) {
    if (!sameOrigin(client.url)) {
      continue;
    }

    if (
      shouldSkipNotificationWindow({
        url: client.url,
        origin: self.location.origin,
        uploadInProgress: uploadingClientIds.has(client.id)
      })
    ) {
      continue;
    }

    return focusOrOpen(client, targetHref);
  }

  return self.clients.openWindow(targetHref);
}

async function focusOrOpen(client, targetHref) {
  try {
    if ("navigate" in client && client.url !== targetHref) {
      const navigatedClient = await client.navigate(targetHref);
      if (navigatedClient) {
        return navigatedClient.focus();
      }
    }

    return client.focus();
  } catch (error) {
    return self.clients.openWindow(targetHref);
  }
}

function contextForRequest(request) {
  return {
    url: request.url,
    origin: self.location.origin,
    method: request.method,
    mode: request.mode,
    destination: request.destination,
    accept: request.headers.get("accept")
  };
}

function responseSummary(response) {
  return {
    ok: response.ok,
    redirected: response.redirected,
    cacheControl: response.headers.get("cache-control")
  };
}

function sameOrigin(rawUrl) {
  try {
    return new URL(rawUrl).origin === self.location.origin;
  } catch (error) {
    return false;
  }
}
