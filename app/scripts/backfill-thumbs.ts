import { prisma } from "../lib/db";
import { generateClipThumbnail } from "../lib/thumbnails";

type ParsedArgs = {
  creatorId: string | null;
  force: boolean;
  limit: number;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clips = await prisma.clip.findMany({
    where: {
      creatorId: args.creatorId ?? undefined,
      thumbKey: args.force ? undefined : null,
      video: {
        sourceKey: {
          not: null,
        },
      },
    },
    orderBy: [
      {
        createdAt: "asc",
      },
      {
        id: "asc",
      },
    ],
    take: args.limit,
    select: {
      id: true,
    },
  });

  let generated = 0;
  let exists = 0;
  let skipped = 0;
  let failed = 0;

  for (const clip of clips) {
    try {
      const result = await generateClipThumbnail(clip.id, {
        force: args.force,
      });
      if (result.status === "generated") {
        generated += 1;
      } else if (result.status === "exists") {
        exists += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      console.warn(
        `Thumbnail backfill failed for clip ${clip.id}: ${errorMessage(error)}`,
      );
    }
  }

  console.log(
    [
      "PASSED thumbnail backfill",
      `checked=${clips.length}`,
      `generated=${generated}`,
      `exists=${exists}`,
      `skipped=${skipped}`,
      `failed=${failed}`,
    ].join(" "),
  );
}

function parseArgs(args: string[]): ParsedArgs {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  return {
    creatorId: readOption(args, "--creator-id"),
    force: args.includes("--force"),
    limit: parseLimit(readOption(args, "--limit") ?? "100"),
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

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("--limit must be an integer from 1 to 1000.");
  }
  return limit;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  npm run backfill:thumbs -- [--creator-id <id>] [--limit <n>] [--force]",
      "",
      "Options:",
      "  --creator-id <id>  Limit to one creator.",
      "  --limit <n>       Max clips to scan, default 100.",
      "  --force           Replace existing thumbnails.",
    ].join("\n"),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main()
  .catch((error: unknown) => {
    console.log("FAILED thumbnail backfill");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
