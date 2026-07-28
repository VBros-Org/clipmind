import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // clipmind.gitm.gg terminates TLS at a Cloudflare Worker and proxies to the
  // railway.app origin, so the browser Origin and the server Host disagree.
  // Server Actions reject that mismatch unless the public hosts are listed.
  experimental: {
    // Upload route cap: 2 GB. The route still enforces the same limit before
    // streaming phone uploads to R2.
    proxyClientMaxBodySize: "2gb",
    serverActions: {
      allowedOrigins: ["clipmind.gitm.gg", "app-production-dd6a.up.railway.app"],
    },
  },
};

export default nextConfig;
