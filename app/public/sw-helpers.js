(function () {
  "use strict";

  const root = typeof self !== "undefined" ? self : globalThis;
  const PUBLIC_CACHE = "clipmind-public-v3";
  const OFFLINE_URL = "/offline.html";
  const PRECACHE_URLS = [
    OFFLINE_URL,
    "/manifest.webmanifest",
    "/icons/clipmind-192.png",
    "/icons/clipmind-512.png",
    "/icons/clipmind-maskable-512.png"
  ];

  function cachePolicy(input) {
    if (input.method !== "GET") {
      return "pass-through";
    }

    const url = sameOriginUrl(input.url, input.origin);
    if (!url) {
      return "pass-through";
    }

    if (isMediaDestination(input.destination)) {
      return "pass-through";
    }

    if (isApiOrDataRequest(input, url)) {
      return "network-only";
    }

    if (isNavigationRequest(input)) {
      return "navigation";
    }

    if (isPublicAssetPath(url.pathname)) {
      return "public-cache";
    }

    return "network-only";
  }

  function isResponseCacheable(input, response) {
    if (!response.ok || response.redirected) {
      return false;
    }

    const cacheControl = (response.cacheControl || "").toLowerCase();
    if (cacheControl.includes("no-store") || cacheControl.includes("private")) {
      return false;
    }

    return cachePolicy(input) === "public-cache";
  }

  function navigationFallbacks(input) {
    const url = sameOriginUrl(input.url, input.origin);
    const fallbacks = [];

    if (url) {
      fallbacks.push({
        url: url.pathname + url.search,
        ignoreSearch: true
      });

      if (url.pathname === "/home") {
        fallbacks.push({
          url: "/home",
          ignoreSearch: true
        });
      }
    }

    fallbacks.push({
      url: OFFLINE_URL,
      ignoreSearch: false
    });

    return dedupeFallbacks(fallbacks);
  }

  function shouldSkipNotificationWindow(input) {
    return input.uploadInProgress === true;
  }

  function notificationTargetHref(rawUrl, origin) {
    try {
      const url = new URL(rawUrl || "/home", origin);
      if (url.origin === origin) {
        return url.href;
      }
    } catch (error) {
      return new URL("/home", origin).href;
    }

    return new URL("/home", origin).href;
  }

  function isApiOrDataRequest(input, url) {
    return (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/_next/data/") ||
      url.searchParams.has("_rsc") ||
      includesHeader(input.accept, "text/x-component")
    );
  }

  function isNavigationRequest(input) {
    return (
      input.mode === "navigate" ||
      input.destination === "document" ||
      includesHeader(input.accept, "text/html")
    );
  }

  function isPublicAssetPath(pathname) {
    return (
      pathname === OFFLINE_URL ||
      pathname === "/manifest.webmanifest" ||
      pathname.startsWith("/icons/") ||
      pathname.startsWith("/_next/static/")
    );
  }

  function isMediaDestination(destination) {
    return destination === "audio" || destination === "video";
  }

  function sameOriginUrl(rawUrl, origin) {
    try {
      const url = new URL(rawUrl, origin);
      return url.origin === origin ? url : null;
    } catch (error) {
      return null;
    }
  }

  function includesHeader(header, needle) {
    return typeof header === "string" && header.includes(needle);
  }

  function dedupeFallbacks(fallbacks) {
    const seen = new Set();
    return fallbacks.filter((fallback) => {
      const key = `${fallback.url}|${fallback.ignoreSearch}`;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  const api = {
    PUBLIC_CACHE,
    OFFLINE_URL,
    PRECACHE_URLS,
    cachePolicy,
    isResponseCacheable,
    navigationFallbacks,
    notificationTargetHref,
    shouldSkipNotificationWindow
  };

  root.ClipMindPwa = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
