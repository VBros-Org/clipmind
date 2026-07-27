import { prisma } from "../lib/db";
import { markPosted } from "../lib/scheduling-repository";

type ParsedArgs = {
  clipId: string;
  now: Date;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await markPosted(args.clipId, args.now);

  console.log(
    [
      "PASSED mark posted",
      `clipId=${result.clipId}`,
      `creatorId=${result.creatorId}`,
      `videoId=${result.videoId}`,
      `status=${result.status}`,
      `scheduledFor=${result.scheduledFor?.toISOString() ?? "null"}`,
      `postedAt=${result.postedAt.toISOString()}`,
    ].join(" "),
  );
}

function parseArgs(args: string[]): ParsedArgs {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const clipId = readOption(args, "--clip-id");
  const nowValue = readOption(args, "--now") ?? new Date().toISOString();

  if (!clipId) {
    throw new Error(
      "Usage: npm run mark:posted -- --clip-id <id> [--now <iso>]",
    );
  }

  return {
    clipId,
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
      "  npm run mark:posted -- --clip-id <id> [--now <iso>]",
      "",
      "Options:",
      "  --clip-id <id>   Scheduled clip the human has posted.",
      "  --now <iso>      Optional clock override for deterministic tests.",
    ].join("\n"),
  );
}

main()
  .catch((error: unknown) => {
    console.log("FAILED mark posted");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
