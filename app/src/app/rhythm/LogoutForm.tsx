"use client";

import type { FormEvent } from "react";
import { useState } from "react";

import styles from "./rhythm.module.css";
import {
  cleanupDevicePushForLogout,
  forgetRememberedPushToken,
} from "./push-client";

type LogoutCleanup = {
  pushToken: string | null;
};

export function LogoutForm() {
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const form = event.currentTarget;
    setSubmitting(true);

    try {
      const cleanup = await cleanupDeviceForLogout();
      const response = await fetch("/api/session/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          pushToken: cleanup.pushToken,
        }),
      });

      if (!response.ok && !response.redirected) {
        throw new Error("Logout failed.");
      }

      forgetRememberedPushToken();
      window.location.assign(response.redirected ? response.url : "/login");
    } catch {
      HTMLFormElement.prototype.submit.call(form);
    }
  }

  return (
    <form action="/api/session/logout" method="post" onSubmit={handleSubmit}>
      <button className={styles.logoutButton} disabled={submitting} type="submit">
        {submitting ? "Logging out" : "Log out"}
      </button>
    </form>
  );
}

async function cleanupDeviceForLogout(): Promise<LogoutCleanup> {
  const [pushCleanup] = await Promise.allSettled([
    cleanupDevicePushForLogout(),
    purgeOriginCaches(),
  ]);

  return {
    pushToken:
      pushCleanup.status === "fulfilled" ? pushCleanup.value.token : null,
  };
}

async function purgeOriginCaches(): Promise<void> {
  if (!("caches" in window)) {
    return;
  }

  const names = await window.caches.keys();
  await Promise.all(names.map((name) => window.caches.delete(name)));
}
