const FIREBASE_VERSION = "12.16.0";

export const dynamic = "force-static";

export function GET() {
  return new Response(buildServiceWorkerSource(), {
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Type": "application/javascript; charset=utf-8",
    },
  });
}

function buildServiceWorkerSource(): string {
  const config = {
    apiKey: process.env.NEXT_PUBLIC_FCM_API_KEY ?? "",
    projectId: process.env.NEXT_PUBLIC_FCM_PROJECT_ID ?? "",
    messagingSenderId: process.env.NEXT_PUBLIC_FCM_SENDER_ID ?? "",
    appId: process.env.NEXT_PUBLIC_FCM_APP_ID ?? "",
  };

  return `
(function () {
  const firebaseConfig = ${JSON.stringify(config)};
  const hasConfig = firebaseConfig.apiKey &&
    firebaseConfig.projectId &&
    firebaseConfig.messagingSenderId &&
    firebaseConfig.appId;

  if (!hasConfig) {
    return;
  }

  try {
    importScripts("https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app-compat.js");
    importScripts("https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-messaging-compat.js");

    firebase.initializeApp(firebaseConfig);
    const messaging = firebase.messaging();

    messaging.onBackgroundMessage(function (payload) {
      const data = payload.data || {};
      const title = data.title || "ClipMind";
      const body = data.body || "";
      const url = data.url || "/home";
      const kind = data.kind || "nudge";
      const dedupeKey = data.dedupeKey || Date.now().toString();

      return self.registration.showNotification(title, {
        body,
        icon: "/icons/clipmind-192.png",
        badge: "/icons/clipmind-192.png",
        tag: "clipmind-" + kind + "-" + dedupeKey,
        data: {
          url
        }
      });
    });
  } catch (error) {
    console.error("Firebase messaging worker failed", error);
  }
})();`;
}
