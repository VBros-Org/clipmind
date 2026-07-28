import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { ServiceWorkerRegistration } from "../components/ServiceWorkerRegistration";

import "./globals.css";

export const metadata: Metadata = {
  title: "ClipMind",
  description:
    "Upload long video, get ranked clips and captions in your voice, then tap post.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ClipMind",
  },
  icons: {
    icon: [
      {
        url: "/icons/clipmind-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        url: "/icons/clipmind-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
    apple: "/icons/clipmind-192.png",
  },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0d1117",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <ServiceWorkerRegistration />
        {children}
      </body>
    </html>
  );
}
