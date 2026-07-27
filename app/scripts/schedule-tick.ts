import { prisma } from "../lib/db";
import { scheduleTick } from "../lib/scheduling-repository";

type ParsedArgs = {
  creatorId: string;
  now: Date;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await scheduleTick(args.creatorId, args.now);

  if (result.status === "empty") {
    console.log(
      [
        "PASSED schedule tick",
        `creatorId=${result.creatorId}`,
        "scheduled=false",
        `reason=${result.reason}`,
      ].join(" "),
    );
    return;
  }

  console.log(
    [
      "PASSED schedule tick",
      `creatorId=${result.creatorId}`,
      "scheduled=true",
      `clipId=${result.clipId}`,
      `videoId=${result.videoId}`,
      `scheduledFor=${result.scheduledFor.toISOString()}`,
    ].join(" "),
  );
}

function parseArgs(args: string[]): ParsedArgs {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const creatorId = readOption(args, "--creator-id");
  const nowValue = readOption(args, "--now") ?? new Date().toISOString();

  if (!creatorId) {
    throw new Error(
      "Usage: npm run schedule:tick -- --creator-id <id> [--now <iso>]",
    );
  }

  return {
    creatorId,
    now: parseDate(nowValue, "--now"),
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

function parseDate(value: string, option: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${option} must be a valid ISO date.`);
  }
  return date;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  npm run schedule:tick -- --creator-id <id> [--now <iso>]",
      "",
      "Options:",
      "  --creator-id <id>   Creator whose accepted queue should advance.",
      "  --now <iso>         Optional clock override for deterministic tests.",
    ].join("\n"),
  );
}

main()
  .catch((error: unknown) => {
    console.log("FAILED schedule tick");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
