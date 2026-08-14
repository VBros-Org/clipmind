"use client";

import { initializeApp, getApps } from "firebase/app";
import {
  deleteToken,
  getMessaging,
  getToken,
  isSupported,
  onMessage,
  type MessagePayload,
  type Messaging,
} from "firebase/messaging";
import type { PushNotificationPermission } from "../../../lib/push-health";

type SubscribeResult = {
  token: string;
};

type LogoutDeviceCleanup = {
  token: string | null;
};

let messagingPromise: Promise<Messaging | null> | null = null;
const PUSH_TOKEN_STORAGE_KEY = "clipmind.pushToken";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FCM_API_KEY,
  projectId: process.env.NEXT_PUBLIC_FCM_PROJECT_ID,
  messagingSenderId: process.env.NEXT_PUBLIC_FCM_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FCM_APP_ID,
};

export async function subscribeToPushNudges(
  options: { requestPermission: boolean },
): Promise<SubscribeResult> {
  if (!("Notification" in window)) {
    throw new Error("Notifications are not available.");
  }

  if (options.requestPermission && Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error("Notification permission was not granted.");
    }
  }

  if (Notification.permission !== "granted") {
    throw new Error("Notification permission is not granted.");
  }

  if (!("serviceWorker" in navigator)) {
    throw new Error("Service workers are not available.");
  }

  const messaging = await loadMessaging();
  if (!messaging) {
    throw new Error("Firebase messaging is not supported.");
  }

  const registration = await navigator.serviceWorker.ready;
  const vapidKey = process.env.NEXT_PUBLIC_FCM_VAPID_KEY;
  if (!vapidKey) {
    throw new Error("Push VAPID key is not configured.");
  }

  const token = await getToken(messaging, {
    vapidKey,
    serviceWorkerRegistration: registration,
  });
  if (!token) {
    throw new Error("Firebase did not return a push token.");
  }

  rememberPushToken(token);

  const response = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token }),
  });

  if (!response.ok) {
    throw new Error("Push subscription save failed.");
  }

  return {
    token,
  };
}

export function listenForForegroundNudges(): () => void {
  let cancelled = false;
  let unsubscribe: (() => void) | null = null;

  void loadMessaging()
    .then((messaging) => {
      if (!messaging || cancelled) {
        return;
      }

      unsubscribe = onMessage(messaging, (payload) => {
        void showForegroundNudge(payload);
      });
    })
    .catch((error) => {
      console.error("Foreground push listener failed", error);
    });

  return () => {
    cancelled = true;
    unsubscribe?.();
  };
}

export async function cleanupDevicePushForLogout(): Promise<LogoutDeviceCleanup> {
  const registration = await serviceWorkerRegistration();
  const messaging = await loadMessaging().catch(() => null);
  const token =
    readRememberedPushToken() ??
    (await currentFcmToken(messaging, registration).catch(() => null));

  await Promise.allSettled([
    unsubscribeBrowserPush(registration),
    messaging ? deleteToken(messaging) : Promise.resolve(false),
  ]);

  return {
    token,
  };
}

export function forgetRememberedPushToken(): void {
  try {
    window.localStorage.removeItem(PUSH_TOKEN_STORAGE_KEY);
  } catch {
    return;
  }
}

export function hasGrantedPushPermission(): boolean {
  return notificationPermissionState() === "granted";
}

export function notificationPermissionState(): PushNotificationPermission {
  if (!("Notification" in window)) {
    return "unsupported";
  }

  return Notification.permission;
}

async function loadMessaging(): Promise<Messaging | null> {
  messagingPromise ??= loadMessagingOnce();
  return messagingPromise;
}

async function loadMessagingOnce(): Promise<Messaging | null> {
  if (!(await isSupported())) {
    return null;
  }

  const app =
    getApps()[0] ??
    initializeApp({
      apiKey: requirePublicEnv("NEXT_PUBLIC_FCM_API_KEY", firebaseConfig.apiKey),
      projectId: requirePublicEnv(
        "NEXT_PUBLIC_FCM_PROJECT_ID",
        firebaseConfig.projectId,
      ),
      messagingSenderId: requirePublicEnv(
        "NEXT_PUBLIC_FCM_SENDER_ID",
        firebaseConfig.messagingSenderId,
      ),
      appId: requirePublicEnv("NEXT_PUBLIC_FCM_APP_ID", firebaseConfig.appId),
    });

  return getMessaging(app);
}

async function currentFcmToken(
  messaging: Messaging | null,
  registration: ServiceWorkerRegistration | null,
): Promise<string | null> {
  if (!messaging || !registration || notificationPermissionState() !== "granted") {
    return null;
  }

  const vapidKey = process.env.NEXT_PUBLIC_FCM_VAPID_KEY;
  if (!vapidKey) {
    return null;
  }

  return (
    (await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: registration,
    })) || null
  );
}

async function unsubscribeBrowserPush(
  registration: ServiceWorkerRegistration | null,
): Promise<boolean> {
  const subscription = await registration?.pushManager.getSubscription();
  return (await subscription?.unsubscribe()) ?? false;
}

async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) {
    return null;
  }

  return navigator.serviceWorker.ready.catch(() => null);
}

async function showForegroundNudge(payload: MessagePayload): Promise<void> {
  const data = payload.data ?? {};
  const title = data.title || "ClipMind";
  const body = data.body || "";
  const kind = data.kind || "nudge";
  const dedupeKey = data.dedupeKey || Date.now().toString();
  const url = data.url || "/home";

  if (notificationPermissionState() !== "granted") {
    return;
  }

  const registration = await serviceWorkerRegistration();
  await registration?.showNotification(title, {
    body,
    icon: "/icons/clipmind-192.png",
    badge: "/icons/clipmind-192.png",
    tag: `clipmind-${kind}-${dedupeKey}`,
    data: {
      url,
    },
  });
}

function rememberPushToken(token: string): void {
  try {
    window.localStorage.setItem(PUSH_TOKEN_STORAGE_KEY, token);
  } catch {
    return;
  }
}

function readRememberedPushToken(): string | null {
  try {
    const token = window.localStorage.getItem(PUSH_TOKEN_STORAGE_KEY)?.trim();
    return token || null;
  } catch {
    return null;
  }
}

function requirePublicEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is not configured.`);
  }

  return value;
}
