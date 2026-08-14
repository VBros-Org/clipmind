import "./helpers/db-test-guard";

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ClipServiceClient } from "../lib/ingest";
import { ingestVideo, parseClipServiceResponse } from "../lib/ingest";
import { prisma } from "../lib/db";
import type { R2Storage } from "../lib/storage";

async function main() {
  assert.deepEqual(
    parseClipServiceResponse({
      candidates: [
        {
          start_ms: 1_000,
          end_ms: 12_000,
          transcript: "Why this opening works.",
          segments: [
            {
              start_ms: 1_000,
              end_ms: 3_000,
              text: "Why this opening works.",
            },
          ],
          words: [
            { start_ms: 1_000, end_ms: 1_300, word: "Why" },
            { start_ms: 1_300, end_ms: 1_700, word: "this" },
          ],
          reasons: ["transcript hook: question"],
        },
      ],
    }),
    {
      candidates: [
        {
          startMs: 1_000,
          endMs: 12_000,
          transcript: "Why this opening works.",
          transcriptTiming: {
            text: "Why this opening works.",
            segments: [
              {
                start_ms: 1_000,
                end_ms: 3_000,
                text: "Why this opening works.",
              },
            ],
            words: [
              { start_ms: 1_000, end_ms: 1_300, word: "Why" },
              { start_ms: 1_300, end_ms: 1_700, word: "this" },
            ],
          },
          reasons: ["transcript hook: question"],
        },
      ],
    },
  );

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "clipmind-ingest-test-"));
  const videoPath = path.join(tempDir, "sample.mp4");
  const marker = `ingest-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let creatorId: string | null = null;
  let clipServiceCallCount = 0;
  let sourceUploadCount = 0;
  let sourcePresignCount = 0;

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

        assert.equal(source.kind, "url");

        const pendingVideo = await prisma.video.findFirst({
          where: {
            creatorId: creator.id,
          },
          select: {
            sourceKey: true,
            status: true,
          },
        });

        assert.equal(pendingVideo?.status, "uploaded");
        assert.equal(
          source.sourceUrl,
          `https://signed.example/${pendingVideo?.sourceKey}`,
        );
        assert.equal(
          pendingVideo?.sourceKey?.startsWith("videos/"),
          true,
        );
        assert.equal(
          pendingVideo?.sourceKey?.endsWith("/source.mp4"),
          true,
        );

        return {
          candidates: [
            {
              startMs: 1_000,
              endMs: 12_000,
              transcript: "Why this opening works.",
              transcriptTiming: {
                text: "Why this opening works.",
                segments: [
                  {
                    start_ms: 1_000,
                    end_ms: 3_000,
                    text: "Why this opening works.",
                  },
                ],
                words: [
                  { start_ms: 1_000, end_ms: 1_300, word: "Why" },
                  { start_ms: 1_300, end_ms: 1_700, word: "this" },
                ],
              },
              reasons: ["transcript hook: question"],
            },
            {
              startMs: 20_000,
              endMs: 42_000,
              transcript: "Wait for the turn here.",
              transcriptTiming: {
                text: "Wait for the turn here.",
                segments: [
                  {
                    start_ms: 20_000,
                    end_ms: 24_000,
                    text: "Wait for the turn here.",
                  },
                ],
                words: [
                  { start_ms: 20_000, end_ms: 20_400, word: "Wait" },
                  { start_ms: 20_400, end_ms: 20_700, word: "for" },
                ],
              },
              reasons: [
                "transcript hook: emphasis",
                "audio energy: spike above rolling baseline",
              ],
            },
          ],
        };
      },
    };
    const storage = {
      async uploadSource(videoId, source) {
        sourceUploadCount += 1;
        assert.equal(source, resolvedVideoPath);
        return `videos/${videoId}/source.mp4`;
      },
      async presignSourceUrl(key) {
        sourcePresignCount += 1;
        return `https://signed.example/${key}`;
      },
    } satisfies Pick<R2Storage, "uploadSource" | "presignSourceUrl">;

    const firstResult = await ingestVideo(creator.id, videoPath, {
      clipServiceClient,
      storage,
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
    assert.equal(video.sourceKey, `videos/${video.id}/source.mp4`);
    assert.equal(video.contentKey?.startsWith("sha256:"), true);
    assert.equal(video.clips.length, 2);
    assert.equal(video.clips[0].startMs, 1_000);
    assert.equal(video.clips[0].endMs, 12_000);
    assert.equal(video.clips[0].status, "candidate");
    assert.equal(video.clips[0].transcript, "Why this opening works.");
    assert.deepEqual(video.clips[0].transcriptTiming, {
      text: "Why this opening works.",
      segments: [
        {
          start_ms: 1_000,
          end_ms: 3_000,
          text: "Why this opening works.",
        },
      ],
      words: [
        { start_ms: 1_000, end_ms: 1_300, word: "Why" },
        { start_ms: 1_300, end_ms: 1_700, word: "this" },
      ],
    });
    assert.deepEqual(video.clips[0].reasons, ["transcript hook: question"]);
    assert.equal(video.clips[1].startMs, 20_000);
    assert.equal(video.clips[1].endMs, 42_000);
    assert.equal(video.clips[1].transcript, "Wait for the turn here.");
    assert.deepEqual(video.clips[1].transcriptTiming, {
      text: "Wait for the turn here.",
      segments: [
        {
          start_ms: 20_000,
          end_ms: 24_000,
          text: "Wait for the turn here.",
        },
      ],
      words: [
        { start_ms: 20_000, end_ms: 20_400, word: "Wait" },
        { start_ms: 20_400, end_ms: 20_700, word: "for" },
      ],
    });
    assert.deepEqual(video.clips[1].reasons, [
      "transcript hook: emphasis",
      "audio energy: spike above rolling baseline",
    ]);

    const secondResult = await ingestVideo(creator.id, videoPath, {
      clipServiceClient,
      storage,
    });

    assert.equal(secondResult.videoId, firstResult.videoId);
    assert.equal(secondResult.status, "clipped");
    assert.equal(secondResult.createdVideo, false);
    assert.equal(secondResult.createdClipCount, 0);
    assert.equal(secondResult.clipCount, 2);
    assert.equal(secondResult.skippedExisting, true);
    assert.equal(clipServiceCallCount, 1);
    assert.equal(sourceUploadCount, 1);
    assert.equal(sourcePresignCount, 1);

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
