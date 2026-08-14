"use client";

import { useEffect } from "react";

import { listenForForegroundNudges } from "../app/rhythm/push-client";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    const isLocalhost =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1" ||
      window.location.hostname === "[::1]";

    if (window.location.protocol !== "https:" && !isLocalhost) {
      return;
    }

    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  useEffect(() => {
    // Roll the 30-day creator session cookie on real activity (once per app
    // load), so active creators never hit the fixed-expiry logout.
    fetch("/api/session/heartbeat", { method: "POST" }).catch(() => {});
  }, []);

  useEffect(() => {
    return listenForForegroundNudges();
  }, []);

  return null;
}
