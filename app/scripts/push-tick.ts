type ParsedArgs = {
  url: string;
  secret: string;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const response = await fetch(args.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.secret}`,
    },
  });
  const body = (await response.json().catch(() => null)) as {
    messageIds?: string[];
    sent?: number;
    skippedDuplicate?: number;
  } | null;

  if (!response.ok) {
    console.log("FAILED push tick");
    console.error(body ?? { status: response.status });
    process.exitCode = 1;
    return;
  }

  console.log(
    [
      "PASSED push tick",
      `sent=${body?.sent ?? 0}`,
      `skippedDuplicate=${body?.skippedDuplicate ?? 0}`,
      `messageIds=${(body?.messageIds ?? []).join(",") || "none"}`,
    ].join(" "),
  );
}

function parseArgs(args: string[]): ParsedArgs {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const baseUrl =
    readOption(args, "--base-url") ??
    process.env.PUSH_TICK_BASE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000";
  const secret = readOption(args, "--secret") ?? process.env.CRON_SECRET;

  if (!secret) {
    throw new Error("CRON_SECRET is required.");
  }

  return {
    url: `${baseUrl.replace(/\/$/, "")}/api/push/tick`,
    secret,
  };
}

function readOption(args: string[], name: string): string | null {
  const exactIndex = args.indexOf(name);

  if (exactIndex >= 0) {
    return args[exactIndex + 1] ?? null;
  }

  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : null;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  npm run push:tick -- --base-url <url> [--secret <secret>]",
      "",
      "Options:",
      "  --base-url <url>   App origin. Defaults to http://localhost:3000.",
      "  --secret <secret>  Optional override for CRON_SECRET.",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  console.log("FAILED push tick");
  console.error(error);
  process.exitCode = 1;
});
