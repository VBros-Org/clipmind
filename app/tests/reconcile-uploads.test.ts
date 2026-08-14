import test from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../lib/db";
import type { R2Storage } from "../lib/storage";
import { reconcileUploads } from "../scripts/reconcile-uploads";

test("reconcile upload sweep deletes orphaned media objects with no Clip row", async () => {
  const marker = `reconcile-media-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const creator = await prisma.creator.create({
    data: {
      accessCode: marker,
      channelUrl: `https://example.com/${marker}`,
      mindId: `mind-${marker}`,
    },
  });
  const video = await prisma.video.create({
    data: {
      creatorId: creator.id,
      contentKey: `${marker}-content`,
      sourceKey: `videos/${marker}/source.mp4`,
      status: "clipped",
      pipelineStage: "done",
    },
  });
  const clip = await prisma.clip.create({
    data: {
      creatorId: creator.id,
      videoId: video.id,
      startMs: 0,
      endMs: 8_000,
      status: "candidate",
    },
  });
  const orphanClipId = `${marker}-orphan`;
  const deletedMediaKeys: string[] = [];
  const logLines: string[] = [];
  const storage = {
    async listSourceMultipartUploads() {
      return [];
    },
    async listSourceObjects() {
      return [];
    },
    async listMediaObjects(prefix: string) {
      if (prefix === "clips/") {
        return [
          {
            key: `clips/${clip.id}.mp4`,
            size: 1,
            lastModified: new Date("2026-08-14T00:00:00.000Z"),
          },
          {
            key: `clips/${orphanClipId}.mp4`,
            size: 1,
            lastModified: new Date("2026-08-14T00:00:00.000Z"),
          },
        ];
      }
      if (prefix === "thumbs/") {
        return [
          {
            key: `thumbs/${clip.id}.jpg`,
            size: 1,
            lastModified: new Date("2026-08-14T00:00:00.000Z"),
          },
          {
            key: `thumbs/${orphanClipId}.jpg`,
            size: 1,
            lastModified: new Date("2026-08-14T00:00:00.000Z"),
          },
        ];
      }

      return [];
    },
    async deleteMediaObject(key: string) {
      deletedMediaKeys.push(key);
    },
    async abortSourceMultipartUpload() {},
    async deleteSource() {},
  } as unknown as R2Storage;

  try {
    const counts = await reconcileUploads(
      {
        execute: true,
        staleHours: 24,
        limit: 500,
        prefix: "videos/",
      },
      {
        db: prisma,
        storage,
        now: new Date("2026-08-14T12:00:00.000Z"),
        logger: {
          log(line) {
            logLines.push(line);
          },
        },
      },
    );

    assert.equal(counts.mediaOrphanObjects, 2);
    assert.equal(counts.mediaDeletes, 2);
    assert.deepEqual(deletedMediaKeys.sort(), [
      `clips/${orphanClipId}.mp4`,
      `thumbs/${orphanClipId}.jpg`,
    ]);
    assert.match(logLines[0] ?? "", /PASSED upload reconcile/);
    assert.match(logLines[0] ?? "", /mediaOrphanObjects=2/);
    assert.match(logLines[0] ?? "", /mediaDeletes=2/);
  } finally {
    await prisma.clip.deleteMany({
      where: {
        creatorId: creator.id,
      },
    });
    await prisma.video.deleteMany({
      where: {
        creatorId: creator.id,
      },
    });
    await prisma.creator.deleteMany({
      where: {
        id: creator.id,
      },
    });
  }
});
