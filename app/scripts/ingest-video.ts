import { ingestVideo } from "../lib/ingest";
import { prisma } from "../lib/db";

type ParsedArgs = {
  creatorId: string;
  video: string;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await ingestVideo(args.creatorId, args.video);

  const video = await prisma.video.findUnique({
    where: {
      id: result.videoId,
    },
    select: {
      status: true,
      clips: {
        select: {
          id: true,
          status: true,
        },
      },
    },
  });

  if (!video) {
    throw new Error(`Video ${result.videoId} was not found after ingest.`);
  }

  console.log(
    [
      "PASSED ingest video",
      `videoId=${result.videoId}`,
      `status=${video.status}`,
      `clipCount=${video.clips.length}`,
      `createdVideo=${result.createdVideo}`,
      `createdClipCount=${result.createdClipCount}`,
      `skippedExisting=${result.skippedExisting}`,
    ].join(" "),
  );
}

function parseArgs(args: string[]): ParsedArgs {
  const creatorId = readOption(args, "--creator-id");
  const video = readOption(args, "--video");

  if (!creatorId || !video) {
    throw new Error(
      "Usage: npm run ingest:video -- --creator-id <id> --video <path-or-url>",
    );
  }

  return {
    creatorId,
    video,
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

main()
  .catch((error: unknown) => {
    console.log("FAILED ingest video");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
