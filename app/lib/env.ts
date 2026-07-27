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
};
