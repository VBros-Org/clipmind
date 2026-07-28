import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // clipmind.gitm.gg terminates TLS at a Cloudflare Worker and proxies to the
  // railway.app origin, so the browser Origin and the server Host disagree.
  // Server Actions reject that mismatch unless the public hosts are listed.
  experimental: {
    serverActions: {
      allowedOrigins: ["clipmind.gitm.gg", "app-production-dd6a.up.railway.app"],
    },
  },
};

export default nextConfig;
