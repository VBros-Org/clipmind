import { prisma } from "../lib/db";
import { rankCandidates } from "../lib/ranking";

type ParsedArgs = {
  creatorId: string;
  videoId: string;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await rankCandidates(args.creatorId, args.videoId, {
    prismaClient: prisma,
  });

  if (result.status === "failed") {
    console.log(
      [
        "FAILED rank clips",
        `creatorId=${result.creatorId}`,
        `videoId=${result.videoId}`,
        `reason=${result.reason}`,
        `attempts=${result.attempts}`,
      ].join(" "),
    );
    process.exitCode = 1;
    return;
  }

  if (result.status === "empty") {
    console.log(
      [
        "PASSED rank clips",
        `creatorId=${result.creatorId}`,
        `videoId=${result.videoId}`,
        "ranked=false",
        `reason=${result.reason}`,
      ].join(" "),
    );
    return;
  }

  console.log(
    [
      "PASSED rank clips",
      `creatorId=${result.creatorId}`,
      `videoId=${result.videoId}`,
      `mindId=${result.mindId}`,
      `attempts=${result.attempts}`,
      `rankedCount=${result.rankings.length}`,
    ].join(" "),
  );

  for (const clip of result.rankings) {
    console.log(
      [
        `rank=${clip.mindRank}`,
        `candidateIndex=${clip.candidateIndex}`,
        `clipId=${clip.clipId}`,
        `status=${clip.status}`,
        `window=${clip.startMs}-${clip.endMs}ms`,
        `reason=${clip.reason}`,
      ].join(" "),
    );
  }
}

function parseArgs(args: string[]): ParsedArgs {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const creatorId = readOption(args, "--creator-id");
  const videoId = readOption(args, "--video-id");

  if (!creatorId || !videoId) {
    throw new Error(
      "Usage: npm run rank:clips -- --creator-id <id> --video-id <id>",
    );
  }

  return {
    creatorId,
    videoId,
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
      "  npm run rank:clips -- --creator-id <id> --video-id <id>",
      "",
      "Options:",
      "  --creator-id <id>   Creator whose Mind should rank candidates.",
      "  --video-id <id>     Video whose candidate clips should be ranked.",
    ].join("\n"),
  );
}

main()
  .catch((error: unknown) => {
    console.log("FAILED rank clips");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
