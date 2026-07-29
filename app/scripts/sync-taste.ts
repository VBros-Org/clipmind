import { prisma } from "../lib/db";
import { syncTasteFeedback } from "../lib/tasteFeedback";

type ParsedArgs = {
  creatorId: string;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await syncTasteFeedback(args.creatorId, {
    prismaClient: prisma,
  });

  if (result.status === "synced") {
    console.log(
      [
        "PASSED taste feedback sync",
        `creatorId=${result.creatorId}`,
        `mindId=${result.mindId}`,
        `alias=${result.alias}`,
        `clipCount=${result.clipIds.length}`,
        `accepted=${result.acceptedCount}`,
        `rejected=${result.rejectedCount}`,
        `syncedAt=${result.syncedAt.toISOString()}`,
      ].join(" "),
    );
    console.log("MIND_CONFIRMATION_START");
    console.log(result.confirmation);
    console.log("MIND_CONFIRMATION_END");
    return;
  }

  console.log(
    [
      "PASSED taste feedback sync",
      `creatorId=${result.creatorId}`,
      `synced=false`,
      `reason=${result.reason}`,
    ].join(" "),
  );
}

function parseArgs(args: string[]): ParsedArgs {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const creatorId = readOption(args, "--creator-id");

  if (!creatorId) {
    throw new Error("Usage: npm run sync:taste -- --creator-id <id>");
  }

  return {
    creatorId,
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
      "  npm run sync:taste -- --creator-id <id>",
      "",
      "Options:",
      "  --creator-id <id>   Creator whose Mind should learn from unsynced verdicts.",
    ].join("\n"),
  );
}

main()
  .catch((error: unknown) => {
    console.log("FAILED taste feedback sync");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
