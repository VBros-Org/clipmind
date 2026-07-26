const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required. Set it in app/.env before running backend code.",
  );
}

export const env = {
  DATABASE_URL: databaseUrl,
};
