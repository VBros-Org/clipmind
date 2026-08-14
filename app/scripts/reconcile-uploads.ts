import type { PrismaClient } from "@prisma/client";

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
  mediaOrphanObjects: number;
  mediaDeletes: number;
};

type ReconcileUploadsOptions = {
  db?: PrismaClient;
  storage?: R2Storage;
  now?: Date;
  logger?: Pick<Console, "log">;
};

export async function reconcileUploads(
  args: ParsedArgs,
  options: ReconcileUploadsOptions = {},
): Promise<ReconcileCounts> {
  const db = options.db ?? prisma;
  const storage = options.storage ?? createR2Storage();
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - args.staleHours * 60 * 60 * 1000);
  const counts: ReconcileCounts = {
    staleIntents: 0,
    dbMultipartAborts: 0,
    r2MultipartAborts: 0,
    orphanObjects: 0,
    sourceDeletes: 0,
    mediaOrphanObjects: 0,
    mediaDeletes: 0,
  };

  const staleIntents = await db.uploadIntent.findMany({
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
      await db.uploadIntent.updateMany({
        where: {
          id: intent.id,
          status: {
            not: "completed",
          },
        },
        data: {
          status: "aborted",
          failureReason: "Stale multipart upload reconciled.",
          abortedAt: now,
          lastActivityAt: now,
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

    const tracked = await db.uploadIntent.findFirst({
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
          db.video.findMany({
            where: {
              sourceKey: {
                in: sourceKeys,
              },
            },
            select: {
              sourceKey: true,
            },
          }),
          db.uploadIntent.findMany({
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

  const mediaObjects = (
    await Promise.all([
      storage.listMediaObjects("clips/"),
      storage.listMediaObjects("thumbs/"),
    ])
  )
    .flat()
    .filter((object) => mediaObjectClipId(object.key))
    .slice(0, args.limit);
  const mediaClipIds = [
    ...new Set(
      mediaObjects
        .map((object) => mediaObjectClipId(object.key))
        .filter((clipId): clipId is string => Boolean(clipId)),
    ),
  ];
  const clips =
    mediaClipIds.length > 0
      ? await db.clip.findMany({
          where: {
            id: {
              in: mediaClipIds,
            },
          },
          select: {
            id: true,
          },
        })
      : [];
  const clipIdsWithRows = new Set(clips.map((clip) => clip.id));

  for (const object of mediaObjects) {
    const clipId = mediaObjectClipId(object.key);
    if (clipId && clipIdsWithRows.has(clipId)) {
      continue;
    }

    counts.mediaOrphanObjects += 1;
    if (args.execute) {
      await storage.deleteMediaObject(object.key);
      counts.mediaDeletes += 1;
    }
  }

  (options.logger ?? console).log(
    [
      "PASSED upload reconcile",
      `dryRun=${String(!args.execute)}`,
      `staleIntents=${counts.staleIntents}`,
      `dbMultipartAborts=${counts.dbMultipartAborts}`,
      `r2MultipartAborts=${counts.r2MultipartAborts}`,
      `orphanObjects=${counts.orphanObjects}`,
      `sourceDeletes=${counts.sourceDeletes}`,
      `mediaOrphanObjects=${counts.mediaOrphanObjects}`,
      `mediaDeletes=${counts.mediaDeletes}`,
    ].join(" "),
  );

  return counts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await reconcileUploads(args);
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

function mediaObjectClipId(key: string): string | null {
  const match = /^(?:clips|thumbs)\/(.+)\.(?:mp4|jpg)$/u.exec(key.trim());
  return match?.[1]?.trim() || null;
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
      "  Media orphan sweep always checks clips/ and thumbs/ in the media bucket.",
    ].join("\n"),
  );
}

if (require.main === module) {
  main()
    .catch((error: unknown) => {
      console.log("FAILED upload reconcile");
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
