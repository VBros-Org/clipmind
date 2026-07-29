"use client";

import { initializeApp, getApps } from "firebase/app";
import {
  getMessaging,
  getToken,
  isSupported,
  type Messaging,
} from "firebase/messaging";

type SubscribeResult = {
  token: string;
};

let messagingPromise: Promise<Messaging | null> | null = null;

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

export function hasGrantedPushPermission(): boolean {
  return "Notification" in window && Notification.permission === "granted";
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

function requirePublicEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is not configured.`);
  }

  return value;
}
