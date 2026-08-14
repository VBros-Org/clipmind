export type Header = {
  key: string;
  value: string;
};

export type SecurityHeaderOptions = {
  mediaPublicBase?: string | null;
  r2AccountId?: string | null;
  r2SourcesBucket?: string | null;
  nodeEnv?: string;
};

const FIREBASE_CONNECT_SOURCES = [
  "https://firebaseinstallations.googleapis.com",
  "https://fcmregistrations.googleapis.com",
];

// CSP allowance notes:
// script-src unsafe-inline is required by Next App Router hydration scripts.
// script-src unsafe-eval is development-only for Next dev tooling.
// style-src unsafe-inline is required by Next style tags and runtime width or
// transform styles used by upload progress and reject undo UI.
// img-src data: covers inline image data while self and R2 cover app assets,
// icons, thumbnails, and media posters.
// media-src blob: covers locally prepared MP4 object URLs for save/download.
// connect-src Firebase hosts are used by the browser SDK for installations and
// FCM web registration tokens. Same-origin covers app APIs. R2 covers MP4 fetch.
// The presigned SOURCES bucket origin (virtual-host style
// https://<bucket>.<account>.r2.cloudflarestorage.com) must be in media-src
// (review preview plays presigned source URLs) and connect-src (multipart
// upload PUTs go direct to it from the browser) or both features break.
// frame-ancestors none prevents embedding through CSP rather than X-Frame-Options.
export function buildSecurityHeaders(
  options: SecurityHeaderOptions = {},
): Header[] {
  return [
    {
      key: "Content-Security-Policy",
      value: buildContentSecurityPolicy(options),
    },
    {
      key: "X-Content-Type-Options",
      value: "nosniff",
    },
    {
      key: "Referrer-Policy",
      value: "strict-origin-when-cross-origin",
    },
    {
      key: "Permissions-Policy",
      value: [
        "camera=()",
        "microphone=()",
        "geolocation=()",
        "payment=()",
        "usb=()",
        "serial=()",
        "hid=()",
        "browsing-topics=()",
      ].join(", "),
    },
  ];
}

export function buildContentSecurityPolicy(
  options: SecurityHeaderOptions = {},
): string {
  const mediaOrigin = cspOrigin(
    options.mediaPublicBase ?? process.env.R2_MEDIA_PUBLIC_BASE,
  );
  const sourcesOrigin = r2SourcesOrigin(
    options.r2SourcesBucket ?? process.env.R2_SOURCES_BUCKET,
    options.r2AccountId ?? process.env.R2_ACCOUNT_ID,
  );
  const scriptSources = ["'self'", "'unsafe-inline'"];
  if ((options.nodeEnv ?? process.env.NODE_ENV) !== "production") {
    scriptSources.push("'unsafe-eval'");
  }

  const imageSources = compact(["'self'", "data:", mediaOrigin]);
  const mediaSources = compact(["'self'", "blob:", mediaOrigin, sourcesOrigin]);
  const connectSources = compact([
    "'self'",
    mediaOrigin,
    sourcesOrigin,
    ...FIREBASE_CONNECT_SOURCES,
  ]);

  return [
    directive("default-src", ["'self'"]),
    directive("base-uri", ["'self'"]),
    directive("script-src", scriptSources),
    directive("style-src", ["'self'", "'unsafe-inline'"]),
    directive("img-src", imageSources),
    directive("media-src", mediaSources),
    directive("connect-src", connectSources),
    directive("font-src", ["'self'"]),
    directive("manifest-src", ["'self'"]),
    directive("worker-src", ["'self'", "blob:"]),
    directive("object-src", ["'none'"]),
    directive("frame-src", ["'none'"]),
    directive("frame-ancestors", ["'none'"]),
    directive("form-action", ["'self'"]),
  ].join("; ");
}

function directive(name: string, values: string[]): string {
  return `${name} ${[...new Set(values)].join(" ")}`;
}

function compact(values: Array<string | null>): string[] {
  return values.filter((value): value is string => Boolean(value));
}

function r2SourcesOrigin(
  bucket: string | null | undefined,
  accountId: string | null | undefined,
): string | null {
  const cleanBucket = bucket?.trim();
  const cleanAccount = accountId?.trim();
  if (!cleanBucket || !cleanAccount) {
    return null;
  }

  return `https://${cleanBucket}.${cleanAccount}.r2.cloudflarestorage.com`;
}

function cspOrigin(value: string | null | undefined): string | null {
  const clean = value?.trim();
  if (!clean) {
    return null;
  }

  try {
    return new URL(clean).origin;
  } catch {
    return null;
  }
}
