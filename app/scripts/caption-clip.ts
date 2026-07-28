import { prisma } from "../lib/db";
import { captionClip } from "../lib/captioning";

type ParsedArgs = {
  clipId: string;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await captionClip(args.clipId, {
    prismaClient: prisma,
  });

  if (result.status === "failed") {
    console.log(
      [
        "FAILED caption clip",
        `clipId=${result.clipId}`,
        `creatorId=${result.creatorId}`,
        `videoId=${result.videoId}`,
        `mindId=${result.mindId}`,
        `reason=${result.reason}`,
        `attempts=${result.attempts}`,
      ].join(" "),
    );
    for (const error of result.errors) {
      console.log(`error=${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    [
      "PASSED caption clip",
      `clipId=${result.clipId}`,
      `creatorId=${result.creatorId}`,
      `videoId=${result.videoId}`,
      `mindId=${result.mindId}`,
      `attempts=${result.attempts}`,
    ].join(" "),
  );
  console.log(`youtube=${result.variants.youtube}`);
  console.log(`tiktok=${result.variants.tiktok}`);
  console.log(`instagram=${result.variants.instagram}`);
}

function parseArgs(args: string[]): ParsedArgs {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const clipId = readOption(args, "--clip-id");

  if (!clipId) {
    throw new Error("Usage: npm run caption:clip -- --clip-id <id>");
  }

  return {
    clipId,
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
      "  npm run caption:clip -- --clip-id <id>",
      "",
      "Options:",
      "  --clip-id <id>   Clip whose creator Mind should write post-copy.",
    ].join("\n"),
  );
}

main()
  .catch((error: unknown) => {
    console.log("FAILED caption clip");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
