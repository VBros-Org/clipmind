import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ClipServiceClient } from "../lib/ingest";
import { ingestVideo } from "../lib/ingest";
import { prisma } from "../lib/db";

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clipmind-ingest-test-"));
  const videoPath = path.join(tempDir, "sample.mp4");
  const marker = `ingest-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let creatorId: string | null = null;
  let clipServiceCallCount = 0;

  try {
    await writeFile(videoPath, Buffer.from(`fake-video-${marker}`));
    const resolvedVideoPath = await realpath(videoPath);

    const creator = await prisma.creator.create({
      data: {
        channelUrl: `https://example.com/${marker}`,
        mindId: `mind-${marker}`,
        captionStyle: {
          preset: "clean-bold",
        },
      },
    });
    creatorId = creator.id;

    const clipServiceClient: ClipServiceClient = {
      async fetchCandidates(source) {
        clipServiceCallCount += 1;

        assert.equal(source.kind, "file");
        assert.equal(source.path, resolvedVideoPath);

        const pendingVideo = await prisma.video.findFirst({
          where: {
            creatorId: creator.id,
          },
          select: {
            status: true,
          },
        });

        assert.equal(pendingVideo?.status, "uploaded");

        return {
          candidates: [
            {
              startMs: 1_000,
              endMs: 12_000,
              transcript: "Why this opening works.",
              reasons: ["transcript hook: question"],
            },
            {
              startMs: 20_000,
              endMs: 42_000,
              transcript: "Wait for the turn here.",
              reasons: [
                "transcript hook: emphasis",
                "audio energy: spike above rolling baseline",
              ],
            },
          ],
        };
      },
    };

    const firstResult = await ingestVideo(creator.id, videoPath, {
      clipServiceClient,
    });

    assert.equal(firstResult.status, "clipped");
    assert.equal(firstResult.createdVideo, true);
    assert.equal(firstResult.createdClipCount, 2);
    assert.equal(firstResult.clipCount, 2);
    assert.equal(firstResult.skippedExisting, false);

    const video = await prisma.video.findUniqueOrThrow({
      where: {
        id: firstResult.videoId,
      },
      include: {
        clips: {
          orderBy: {
            startMs: "asc",
          },
        },
      },
    });

    assert.equal(video.status, "clipped");
    assert.equal(video.sourceUrl, null);
    assert.equal(video.contentKey?.startsWith("sha256:"), true);
    assert.equal(video.clips.length, 2);
    assert.equal(video.clips[0].startMs, 1_000);
    assert.equal(video.clips[0].endMs, 12_000);
    assert.equal(video.clips[0].status, "candidate");
    assert.equal(video.clips[0].transcript, "Why this opening works.");
    assert.deepEqual(video.clips[0].reasons, ["transcript hook: question"]);
    assert.equal(video.clips[1].startMs, 20_000);
    assert.equal(video.clips[1].endMs, 42_000);
    assert.equal(video.clips[1].transcript, "Wait for the turn here.");
    assert.deepEqual(video.clips[1].reasons, [
      "transcript hook: emphasis",
      "audio energy: spike above rolling baseline",
    ]);

    const secondResult = await ingestVideo(creator.id, videoPath, {
      clipServiceClient,
    });

    assert.equal(secondResult.videoId, firstResult.videoId);
    assert.equal(secondResult.status, "clipped");
    assert.equal(secondResult.createdVideo, false);
    assert.equal(secondResult.createdClipCount, 0);
    assert.equal(secondResult.clipCount, 2);
    assert.equal(secondResult.skippedExisting, true);
    assert.equal(clipServiceCallCount, 1);

    const videoCount = await prisma.video.count({
      where: {
        creatorId: creator.id,
      },
    });
    const clipCount = await prisma.clip.count({
      where: {
        creatorId: creator.id,
      },
    });

    assert.equal(videoCount, 1);
    assert.equal(clipCount, 2);

    console.log(
      `PASSED ingest tests videoId=${firstResult.videoId} clipCount=${clipCount} clipServiceCalls=${clipServiceCallCount}`,
    );
  } catch (error) {
    console.log("FAILED ingest tests");
    throw error;
  } finally {
    if (creatorId) {
      await prisma.clip.deleteMany({
        where: {
          creatorId,
        },
      });
      await prisma.video.deleteMany({
        where: {
          creatorId,
        },
      });
      await prisma.creator.delete({
        where: {
          id: creatorId,
        },
      });
    }

    await rm(tempDir, {
      force: true,
      recursive: true,
    });
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
