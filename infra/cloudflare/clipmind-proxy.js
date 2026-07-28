// clipmind.gitm.gg -> Railway app service reverse proxy.
// Railway's native custom-domain cert issuance stuck at VALIDATING_OWNERSHIP
// (2026-07-28), so Cloudflare terminates TLS and this Worker forwards to the
// railway.app origin. Remove if/when Railway's native domain routing works.
const ORIGIN = "app-production-dd6a.up.railway.app";
export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = ORIGIN;
    const req = new Request(url, request);
    req.headers.set("X-Forwarded-Host", "clipmind.gitm.gg");
    return fetch(req);
  },
};
