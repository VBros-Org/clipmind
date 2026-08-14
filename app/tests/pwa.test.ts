import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

import { detectInstallPlatform } from "../lib/install";

type WebManifest = {
  name?: string;
  short_name?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  theme_color?: string;
  background_color?: string;
  icons?: Array<{
    src?: string;
    sizes?: string;
    type?: string;
    purpose?: string;
  }>;
};

type ServiceWorkerHelpers = {
  PUBLIC_CACHE: string;
  PRECACHE_URLS: string[];
  cachePolicy(input: HelperRequest): string;
  isResponseCacheable(
    input: HelperRequest,
    response: {
      ok: boolean;
      redirected: boolean;
      cacheControl: string | null;
    },
  ): boolean;
  navigationFallbacks(input: HelperRequest): Array<{
    url: string;
    ignoreSearch: boolean;
  }>;
  notificationTargetHref(rawUrl: string | null, origin: string): string;
  shouldSkipNotificationWindow(input: {
    url: string;
    origin: string;
    uploadInProgress: boolean;
  }): boolean;
};

type HelperRequest = {
  url: string;
  origin: string;
  method: string;
  mode: string;
  destination: string;
  accept: string | null;
};

test("manifest has the required PWA fields and icon files", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(process.cwd(), "public/manifest.webmanifest"), "utf8"),
  ) as WebManifest;

  assert.equal(manifest.name, "ClipMind");
  assert.equal(manifest.short_name, "ClipMind");
  assert.equal(manifest.start_url, "/home");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#5fb3b3");
  assert.equal(manifest.background_color, "#0d1117");

  const icons = manifest.icons ?? [];
  assertHasIcon(icons, "192x192", "any");
  assertHasIcon(icons, "512x512", "any");
  assertHasIcon(icons, "512x512", "maskable");

  await Promise.all(
    icons.map((icon) => {
      const src = icon.src;
      if (!src?.startsWith("/icons/")) {
        throw new Error("Manifest icon source must be under /icons/.");
      }
      assert.equal(icon.type, "image/png");
      return access(resolve(process.cwd(), "public", src.slice(1)));
    }),
  );
});

test("service worker uses v3 public-only cache and offline fallback", async () => {
  const serviceWorker = await readFile(
    resolve(process.cwd(), "public/sw.js"),
    "utf8",
  );

  assert.match(serviceWorker, /importScripts\("\/sw-helpers\.js"\)/);
  assert.match(serviceWorker, /PUBLIC_CACHE/);
  assert.doesNotMatch(serviceWorker, /clipmind-shell-v2/);
  assert.doesNotMatch(serviceWorker, /clipmind-data-v1/);
  assert.doesNotMatch(serviceWorker, /networkFirst/);
  assert.match(serviceWorker, /cacheFirstPublicAsset/);
  assert.match(serviceWorker, /networkNavigation/);
  assert.match(serviceWorker, /offlineNavigationFallback/);
  assert.match(serviceWorker, /navigationFallbacks/);
  assert.match(serviceWorker, /ignoreSearch/);
  assert.match(serviceWorker, /uploadingClientIds/);
  assert.match(serviceWorker, /firebase-messaging-sw\.js/);
  assert.match(serviceWorker, /notificationclick/);
  assert.match(serviceWorker, /openWindow\(targetHref\)/);
});

test("service worker helper caches only public assets", async () => {
  const helpers = await loadServiceWorkerHelpers();
  const origin = "https://clipmind.test";

  assert.equal(helpers.PUBLIC_CACHE, "clipmind-public-v3");
  assert.deepEqual(plain(helpers.PRECACHE_URLS), [
    "/offline.html",
    "/manifest.webmanifest",
    "/icons/clipmind-192.png",
    "/icons/clipmind-512.png",
    "/icons/clipmind-maskable-512.png",
  ]);

  assert.equal(
    helpers.cachePolicy(
      helperRequest(origin, "/_next/static/chunk.js", {
        destination: "script",
      }),
    ),
    "public-cache",
  );
  assert.equal(
    helpers.cachePolicy(
      helperRequest(origin, "/icons/clipmind-192.png", {
        destination: "image",
      }),
    ),
    "public-cache",
  );
  assert.equal(
    helpers.cachePolicy(helperRequest(origin, "/manifest.webmanifest")),
    "public-cache",
  );
  assert.equal(
    helpers.cachePolicy(helperRequest(origin, "/offline.html")),
    "public-cache",
  );
  assert.equal(
    helpers.cachePolicy(
      helperRequest(origin, "/home", {
        mode: "navigate",
        destination: "document",
        accept: "text/html",
      }),
    ),
    "navigation",
  );
  assert.equal(
    helpers.cachePolicy(helperRequest(origin, "/api/home")),
    "network-only",
  );
  assert.equal(
    helpers.cachePolicy(helperRequest(origin, "/_next/data/build/home.json")),
    "network-only",
  );
  assert.equal(
    helpers.cachePolicy(
      helperRequest(origin, "/home?_rsc=abc", {
        accept: "text/x-component",
      }),
    ),
    "network-only",
  );
  assert.equal(
    helpers.cachePolicy(helperRequest("https://cdn.example", "/asset.js")),
    "pass-through",
  );
  assert.equal(
    helpers.cachePolicy(
      helperRequest(origin, "/clips/demo.mp4", {
        destination: "video",
      }),
    ),
    "pass-through",
  );
  assert.equal(
    helpers.isResponseCacheable(
      helperRequest(origin, "/_next/static/chunk.js"),
      { ok: true, redirected: false, cacheControl: "no-store" },
    ),
    false,
  );
});

test("service worker helper resolves offline navigation fallbacks", async () => {
  const helpers = await loadServiceWorkerHelpers();
  const origin = "https://clipmind.test";

  assert.deepEqual(
    plain(
      helpers.navigationFallbacks(
        helperRequest(origin, "/home?post=clip_123", {
          mode: "navigate",
          destination: "document",
          accept: "text/html",
        }),
      ),
    ),
    [
      { url: "/home?post=clip_123", ignoreSearch: true },
      { url: "/home", ignoreSearch: true },
      { url: "/offline.html", ignoreSearch: false },
    ],
  );
  assert.deepEqual(
    plain(
      helpers.navigationFallbacks(
        helperRequest(origin, "/review?video=vid_123", {
          mode: "navigate",
          destination: "document",
          accept: "text/html",
        }),
      ),
    ),
    [
      { url: "/review?video=vid_123", ignoreSearch: true },
      { url: "/offline.html", ignoreSearch: false },
    ],
  );
});

test("service worker helper avoids active upload windows on notification click", async () => {
  const helpers = await loadServiceWorkerHelpers();
  const origin = "https://clipmind.test";

  assert.equal(
    helpers.shouldSkipNotificationWindow({
      url: `${origin}/upload`,
      origin,
      uploadInProgress: true,
    }),
    true,
  );
  assert.equal(
    helpers.shouldSkipNotificationWindow({
      url: `${origin}/upload`,
      origin,
      uploadInProgress: false,
    }),
    false,
  );
  assert.equal(
    helpers.notificationTargetHref("/home?post=clip_123", origin),
    `${origin}/home?post=clip_123`,
  );
  assert.equal(
    helpers.notificationTargetHref("https://evil.example/home", origin),
    `${origin}/home`,
  );
});

test("logout client purges caches and unsubscribes the current device push", async () => {
  const logoutForm = await readFile(
    resolve(process.cwd(), "src/app/rhythm/LogoutForm.tsx"),
    "utf8",
  );
  const pushClient = await readFile(
    resolve(process.cwd(), "src/app/rhythm/push-client.ts"),
    "utf8",
  );

  assert.match(logoutForm, /cleanupDevicePushForLogout/);
  assert.match(logoutForm, /purgeOriginCaches/);
  assert.match(logoutForm, /window\.caches\.keys\(\)/);
  assert.match(logoutForm, /window\.caches\.delete\(name\)/);
  assert.match(logoutForm, /"\/api\/session\/logout"/);
  assert.match(logoutForm, /pushToken: cleanup\.pushToken/);

  assert.match(pushClient, /const PUSH_TOKEN_STORAGE_KEY = "clipmind\.pushToken"/);
  assert.match(pushClient, /rememberPushToken\(token\)/);
  assert.match(pushClient, /readRememberedPushToken\(\)/);
  assert.match(pushClient, /pushManager\.getSubscription\(\)/);
  assert.match(pushClient, /\.unsubscribe\(\)/);
  assert.match(pushClient, /deleteToken\(messaging\)/);
});

test("foreground push listener displays onMessage nudges", async () => {
  const registration = await readFile(
    resolve(process.cwd(), "src/components/ServiceWorkerRegistration.tsx"),
    "utf8",
  );
  const pushClient = await readFile(
    resolve(process.cwd(), "src/app/rhythm/push-client.ts"),
    "utf8",
  );

  assert.match(registration, /listenForForegroundNudges/);
  assert.match(pushClient, /onMessage\(messaging/);
  assert.match(pushClient, /showForegroundNudge\(payload\)/);
  assert.match(pushClient, /showNotification\(title/);
  assert.match(pushClient, /tag: `clipmind-\$\{kind\}-\$\{dedupeKey\}`/);
  assert.match(pushClient, /data: \{\s+url,/);
});

test("install platform detection handles installed apps first", () => {
  assert.equal(
    detectInstallPlatform({
      userAgent: androidChromeUa,
      displayModeStandalone: true,
      hasBeforeInstallPrompt: true,
    }),
    "installed",
  );
});

test("install platform detection handles Android and Chrome prompts", () => {
  assert.equal(
    detectInstallPlatform({
      userAgent: androidChromeUa,
      hasBeforeInstallPrompt: true,
    }),
    "android-installable",
  );
});

test("install platform detection handles iOS Safari guide state", () => {
  assert.equal(
    detectInstallPlatform({
      userAgent: iosSafariUa,
      maxTouchPoints: 5,
    }),
    "ios-guided",
  );
});

test("install platform detection rejects unsupported browser state", () => {
  assert.equal(
    detectInstallPlatform({
      userAgent: desktopFirefoxUa,
    }),
    "unsupported",
  );
});

function assertHasIcon(
  icons: NonNullable<WebManifest["icons"]>,
  size: string,
  purpose: string,
) {
  assert.ok(
    icons.some(
      (icon) =>
        icon.sizes === size &&
        icon.type === "image/png" &&
        icon.purpose === purpose,
    ),
    `Expected ${size} ${purpose} PNG icon.`,
  );
}

async function loadServiceWorkerHelpers(): Promise<ServiceWorkerHelpers> {
  const source = await readFile(
    resolve(process.cwd(), "public/sw-helpers.js"),
    "utf8",
  );
  const sandbox = {
    self: {} as { ClipMindPwa?: ServiceWorkerHelpers },
    URL,
    Set,
    module: { exports: {} },
  };

  vm.runInNewContext(source, sandbox, {
    filename: "sw-helpers.js",
  });

  const helpers = sandbox.self.ClipMindPwa;
  assert.ok(helpers);
  return helpers;
}

function helperRequest(
  origin: string,
  path: string,
  overrides: Partial<HelperRequest> = {},
): HelperRequest {
  return {
    url: new URL(path, origin).href,
    origin: "https://clipmind.test",
    method: "GET",
    mode: "same-origin",
    destination: "",
    accept: null,
    ...overrides,
  };
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const androidChromeUa =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36";

const iosSafariUa =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const desktopFirefoxUa =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.0; rv:130.0) Gecko/20100101 Firefox/130.0";
