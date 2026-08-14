const LOCAL_TEST_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOCAL_TEST_DATABASE = "clipmind_dev";
const OVERRIDE_ENV = "CLIPMIND_TEST_DB_OVERRIDE";

export function assertSafeTestDatabaseUrl(
  rawUrl: string | undefined = process.env.DATABASE_URL,
): void {
  if (process.env[OVERRIDE_ENV] === "1") {
    return;
  }

  if (!rawUrl) {
    throw new Error("DATABASE_URL is required for DB-backed tests.");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid Postgres URL for DB-backed tests.");
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const isPostgres = url.protocol === "postgresql:" || url.protocol === "postgres:";
  const isLocalHost = LOCAL_TEST_HOSTS.has(url.hostname);
  const isLocalDatabase = databaseName === LOCAL_TEST_DATABASE;

  if (!isPostgres || !isLocalHost || !isLocalDatabase) {
    throw new Error(
      [
        "Refusing to run DB-backed tests outside localhost/clipmind_dev.",
        `Set ${OVERRIDE_ENV}=1 only for an isolated CI Postgres service container.`,
      ].join(" "),
    );
  }
}

assertSafeTestDatabaseUrl();
