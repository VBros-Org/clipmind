import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

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

test("service worker uses v2 network-first pages and static-only cache first", async () => {
  const serviceWorker = await readFile(
    resolve(process.cwd(), "public/sw.js"),
    "utf8",
  );

  assert.match(serviceWorker, /clipmind-shell-v2/);
  assert.doesNotMatch(serviceWorker, /clipmind-shell-v1/);
  assert.match(serviceWorker, /function isDocumentRequest/);
  assert.match(
    serviceWorker,
    /event\.respondWith\(networkFirst\(request, SHELL_CACHE\)\)/,
  );
  assert.match(serviceWorker, /function networkFirst/);
  assert.match(serviceWorker, /function cacheFirst/);
  assert.match(serviceWorker, /cacheFirst\(request, STATIC_CACHE\)/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/_next\/static\/"\)/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/icons\/"\)/);
  assert.match(serviceWorker, /url\.pathname === "\/manifest\.webmanifest"/);

  const precacheUrls = serviceWorker.match(
    /const PRECACHE_URLS = \[([\s\S]*?)\];/,
  )?.[1] ?? "";
  assert.doesNotMatch(precacheUrls, /"\/"/);
  assert.doesNotMatch(precacheUrls, /"\/login"/);
  assert.doesNotMatch(precacheUrls, /"\/home"/);
  assert.doesNotMatch(precacheUrls, /"\/upload"/);
  assert.doesNotMatch(precacheUrls, /"\/review"/);
  assert.doesNotMatch(precacheUrls, /"\/rhythm"/);

  assert.match(serviceWorker, /function isMediaRequest/);
  assert.match(serviceWorker, /firebase-messaging-sw\.js/);
  assert.match(serviceWorker, /notificationclick/);
  assert.match(serviceWorker, /\/home/);
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

const androidChromeUa =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36";

const iosSafariUa =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const desktopFirefoxUa =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.0; rv:130.0) Gecko/20100101 Firefox/130.0";
