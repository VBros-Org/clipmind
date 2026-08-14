import { prisma } from "../lib/db";
import { createR2Storage, type R2Storage } from "../lib/storage";

type ParsedArgs = {
  execute: boolean;
  staleHours: number;
  limit: number;
  prefix: string;
};

type UploadIntentRow = {
  id: string;
  sourceKey: string;
  uploadId: string | null;
};

type ReconcileCounts = {
  staleIntents: number;
  dbMultipartAborts: number;
  r2MultipartAborts: number;
  orphanObjects: number;
  sourceDeletes: number;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const storage = createR2Storage();
  const cutoff = new Date(Date.now() - args.staleHours * 60 * 60 * 1000);
  const counts: ReconcileCounts = {
    staleIntents: 0,
    dbMultipartAborts: 0,
    r2MultipartAborts: 0,
    orphanObjects: 0,
    sourceDeletes: 0,
  };

  const staleIntents = await prisma.uploadIntent.findMany({
    where: {
      status: {
        in: ["creating", "uploading"],
      },
      lastActivityAt: {
        lt: cutoff,
      },
    },
    orderBy: [
      {
        lastActivityAt: "asc",
      },
      {
        id: "asc",
      },
    ],
    take: args.limit,
    select: {
      id: true,
      sourceKey: true,
      uploadId: true,
    },
  });

  counts.staleIntents = staleIntents.length;
  for (const intent of staleIntents) {
    if (args.execute) {
      await abortIntentMultipart(storage, intent);
      await prisma.uploadIntent.updateMany({
        where: {
          id: intent.id,
          status: {
            not: "completed",
          },
        },
        data: {
          status: "aborted",
          failureReason: "Stale multipart upload reconciled.",
          abortedAt: new Date(),
          lastActivityAt: new Date(),
        },
      });
    }
    if (intent.uploadId) {
      counts.dbMultipartAborts += 1;
    }
  }

  const trackedUploadPairs = new Set(
    staleIntents
      .filter((intent) => intent.uploadId)
      .map((intent) => uploadPairKey(intent.sourceKey, intent.uploadId ?? "")),
  );
  const liveMultipartUploads = (await storage.listSourceMultipartUploads(args.prefix))
    .filter((upload) => upload.initiated !== null && upload.initiated < cutoff)
    .slice(0, args.limit);

  for (const upload of liveMultipartUploads) {
    if (trackedUploadPairs.has(uploadPairKey(upload.key, upload.uploadId))) {
      continue;
    }

    const tracked = await prisma.uploadIntent.findFirst({
      where: {
        sourceKey: upload.key,
        uploadId: upload.uploadId,
      },
      select: {
        id: true,
      },
    });
    if (tracked) {
      continue;
    }

    counts.r2MultipartAborts += 1;
    if (args.execute) {
      await storage.abortSourceMultipartUpload({
        key: upload.key,
        uploadId: upload.uploadId,
      });
    }
  }

  const sourceObjects = (await storage.listSourceObjects(args.prefix))
    .filter((object) => object.key.endsWith("/source.mp4"))
    .slice(0, args.limit);
  const sourceKeys = sourceObjects.map((object) => object.key);
  const [videos, activeIntents] =
    sourceKeys.length > 0
      ? await Promise.all([
          prisma.video.findMany({
            where: {
              sourceKey: {
                in: sourceKeys,
              },
            },
            select: {
              sourceKey: true,
            },
          }),
          prisma.uploadIntent.findMany({
            where: {
              sourceKey: {
                in: sourceKeys,
              },
              status: {
                in: ["creating", "uploading"],
              },
              lastActivityAt: {
                gte: cutoff,
              },
            },
            select: {
              sourceKey: true,
            },
          }),
        ])
      : [[], []];

  const videoKeys = new Set(videos.map((video) => video.sourceKey).filter(Boolean));
  const activeIntentKeys = new Set(
    activeIntents.map((intent) => intent.sourceKey).filter(Boolean),
  );

  for (const object of sourceObjects) {
    if (videoKeys.has(object.key) || activeIntentKeys.has(object.key)) {
      continue;
    }

    counts.orphanObjects += 1;
    if (args.execute) {
      await storage.deleteSource(object.key);
      counts.sourceDeletes += 1;
    }
  }

  console.log(
    [
      "PASSED upload reconcile",
      `dryRun=${String(!args.execute)}`,
      `staleIntents=${counts.staleIntents}`,
      `dbMultipartAborts=${counts.dbMultipartAborts}`,
      `r2MultipartAborts=${counts.r2MultipartAborts}`,
      `orphanObjects=${counts.orphanObjects}`,
      `sourceDeletes=${counts.sourceDeletes}`,
    ].join(" "),
  );
}

async function abortIntentMultipart(
  storage: R2Storage,
  intent: UploadIntentRow,
): Promise<void> {
  if (intent.uploadId) {
    await storage.abortSourceMultipartUpload({
      key: intent.sourceKey,
      uploadId: intent.uploadId,
    });
  }
  await storage.deleteSource(intent.sourceKey);
}

function parseArgs(args: string[]): ParsedArgs {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  return {
    execute: args.includes("--execute"),
    staleHours: parseStaleHours(readOption(args, "--stale-hours") ?? "24"),
    limit: parseLimit(readOption(args, "--limit") ?? "500"),
    prefix: readOption(args, "--prefix") ?? "videos/",
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

function parseStaleHours(value: string): number {
  const staleHours = Number(value);
  if (!Number.isFinite(staleHours) || staleHours < 1 || staleHours > 24 * 30) {
    throw new Error("--stale-hours must be from 1 to 720.");
  }
  return staleHours;
}

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error("--limit must be an integer from 1 to 5000.");
  }
  return limit;
}

function uploadPairKey(sourceKey: string, uploadId: string): string {
  return `${sourceKey}\n${uploadId}`;
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  npm run reconcile:uploads -- [--execute] [--stale-hours <hours>] [--limit <n>] [--prefix <r2-prefix>]",
      "",
      "Options:",
      "  --execute              Apply aborts and deletes. Default is dry-run.",
      "  --stale-hours <hours>  Stale upload cutoff, default 24.",
      "  --limit <n>            Max rows or objects per pass, default 500.",
      "  --prefix <r2-prefix>   Source key prefix, default videos/.",
    ].join("\n"),
  );
}

main()
  .catch((error: unknown) => {
    console.log("FAILED upload reconcile");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
