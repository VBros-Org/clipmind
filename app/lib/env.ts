export type StorageEnv = {
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_SOURCES_BUCKET: string;
  R2_MEDIA_BUCKET: string;
  R2_MEDIA_PUBLIC_BASE: string;
};

const databaseUrl = process.env.DATABASE_URL;
const clipServiceUrl = process.env.CLIP_SERVICE_URL;
const clipServiceToken = process.env.CLIP_SERVICE_TOKEN;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required. Set it in app/.env before running backend code.",
  );
}

if (!clipServiceUrl) {
  throw new Error(
    "CLIP_SERVICE_URL is required. Set it in app/.env before running ingest.",
  );
}

if (!clipServiceToken) {
  throw new Error(
    "CLIP_SERVICE_TOKEN is required. Set it in app/.env before running ingest.",
  );
}

export const env = {
  DATABASE_URL: databaseUrl,
  CLIP_SERVICE_TOKEN: clipServiceToken,
  CLIP_SERVICE_URL: clipServiceUrl,
  MINDS_BUILDER_API_BASE_URL: process.env.MINDS_BUILDER_API_BASE_URL,
  MINDS_BUILDER_API_KEY: process.env.MINDS_BUILDER_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_DISTILL_MODEL: process.env.OPENAI_DISTILL_MODEL,
};

export function requireStorageEnv(source = process.env): StorageEnv {
  const values = {
    R2_ACCOUNT_ID: clean(source.R2_ACCOUNT_ID),
    R2_ACCESS_KEY_ID: clean(source.R2_ACCESS_KEY_ID),
    R2_SECRET_ACCESS_KEY: clean(source.R2_SECRET_ACCESS_KEY),
    R2_SOURCES_BUCKET: clean(source.R2_SOURCES_BUCKET),
    R2_MEDIA_BUCKET: clean(source.R2_MEDIA_BUCKET),
    R2_MEDIA_PUBLIC_BASE: clean(source.R2_MEDIA_PUBLIC_BASE),
  };

  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `R2 storage env missing required variables: ${missing.join(", ")}.`,
    );
  }

  return values as StorageEnv;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
