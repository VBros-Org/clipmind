import test from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../lib/db";
import {
  retryPipeline,
  runPipeline,
  type PipelineStage,
} from "../lib/pipeline";
import type {
  GenerateClipThumbnailOptions,
  GenerateClipThumbnailResult,
} from "../lib/thumbnails";
import type { ClipServiceClient } from "../lib/ingest";
import type { R2Storage } from "../lib/storage";

type PipelineFixture = {
  creatorId: string;
  videoId: string;
};

test("runPipeline progresses uploaded video through ingest, ranking, top-two captions, and done", async () => {
  const fixture = await createPipelineFixture();
  const transitions: PipelineStage[] = [];
  const mindsClient = scriptedMindsClient([
    JSON.stringify([
      { index: 2, reason: "Strongest turn." },
      { index: 1, reason: "Clean setup." },
      { index: 3, reason: "Useful extra." },
    ]),
    captionReply("First top clip"),
    captionReply("Second top clip"),
  ]);
  const thumbnailCalls: string[] = [];

  try {
    const result = await runPipeline(fixture.videoId, {
      prismaClient: prisma,
      ingestOptions: fakeIngestOptions(fixture.videoId),
      rankOptions: {
        mindsClient,
      },
      captionOptions: {
        mindsClient,
      },
      generateClipThumbnailImpl: fakeThumbnailImpl(thumbnailCalls),
      onStageChange(stage) {
        transitions.push(stage);
      },
    });

    assert.equal(result.status, "done");
    assert.deepEqual(transitions, [
      "transcribing",
      "candidates",
      "ranking",
      "captions",
      "done",
    ]);

    const video = await prisma.video.findUniqueOrThrow({
      where: {
        id: fixture.videoId,
      },
      include: {
        clips: {
          orderBy: {
            mindRank: "asc",
          },
        },
      },
    });

    assert.equal(video.pipelineStage, "done");
    assert.equal(video.pipelineError, null);
    assert.equal(video.status, "clipped");
    assert.equal(video.clips.length, 3);
    assert.equal(thumbnailCalls.length, 3);
    assert.equal(video.clips[0]?.mindRank, 1);
    assert.equal(video.clips[0]?.transcript, "Wait for the turn.");
    assert.equal(video.clips[0]?.postCopy, "First top clip for TikTok #clipmind");
    assert.equal(video.clips[0]?.thumbKey?.startsWith("thumbs/"), true);
    assert.equal(video.clips[1]?.mindRank, 2);
    assert.equal(video.clips[1]?.postCopy, "Second top clip for TikTok #clipmind");
    assert.equal(video.clips[2]?.mindRank, 3);
    assert.equal(video.clips[2]?.postCopy, null);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("runPipeline triggers scheduling and taste feedback after the pipeline reaches done", async () => {
  const fixture = await createPipelineFixture();
  const mindsClient = scriptedMindsClient([
    JSON.stringify([
      { index: 2, reason: "Strongest turn." },
      { index: 1, reason: "Clean setup." },
    ]),
    captionReply("First top clip"),
    captionReply("Second top clip"),
    captionReply("Accepted clip"),
  ]);
  const tasteSyncCalls: string[] = [];

  try {
    const acceptedClip = await prisma.clip.create({
      data: {
        creatorId: fixture.creatorId,
        videoId: fixture.videoId,
        startMs: 60_000,
        endMs: 70_000,
        transcript: "Already accepted before completion.",
        status: "accepted",
      },
    });
    await prisma.schedule.create({
      data: {
        creatorId: fixture.creatorId,
        slots: [],
        rotation: {},
        slotsPerDay: 2,
        anchorHour: 9,
      },
    });

    const result = await runPipeline(fixture.videoId, {
      prismaClient: prisma,
      ingestOptions: fakeIngestOptions(fixture.videoId),
      rankOptions: {
        mindsClient,
      },
      captionOptions: {
        mindsClient,
      },
      generateClipThumbnailImpl: fakeThumbnailImpl(),
      syncTasteFeedbackImpl: async (creatorId, options) => {
        assert.equal(creatorId, fixture.creatorId);
        assert.equal(options?.prismaClient, prisma);
        tasteSyncCalls.push(creatorId);
        return {
          status: "empty",
          creatorId,
          reason: "no_unsynced_verdicts",
        };
      },
    });
    assert.equal(result.status, "done");
    assert.deepEqual(tasteSyncCalls, [fixture.creatorId]);

    const scheduledClip = await prisma.clip.findUniqueOrThrow({
      where: {
        id: acceptedClip.id,
      },
      select: {
        status: true,
        scheduledFor: true,
        postCopyVariants: true,
      },
    });
    assert.equal(scheduledClip.status, "scheduled");
    assert.ok(scheduledClip.scheduledFor);
    assert.deepEqual(scheduledClip.postCopyVariants, {
      youtube: "Accepted clip title",
      tiktok: "Accepted clip for TikTok #clipmind",
      instagram: "Accepted clip on Instagram.\nExtra context here\n\n#clipmind",
    });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("runPipeline stores a short named failure for every retryable stage", async () => {
  const cases: {
    stage: "transcribing" | "candidates" | "ranking" | "captions";
    run: (fixture: PipelineFixture) => Promise<void>;
  }[] = [
    {
      stage: "transcribing",
      run: async (fixture) => {
        await runPipeline(fixture.videoId, {
          prismaClient: prisma,
          ingestOptions: {
            storage: fakeStorage(fixture.videoId),
            clipServiceClient: {
              async fetchCandidates() {
                throw new Error("clip service offline");
              },
            },
          },
          generateClipThumbnailImpl: fakeThumbnailImpl(),
        });
      },
    },
    {
      stage: "candidates",
      run: async (fixture) => {
        await runPipeline(fixture.videoId, {
          prismaClient: prisma,
          ingestOptions: {
            storage: fakeStorage(fixture.videoId),
            clipServiceClient: {
              async fetchCandidates() {
                return { candidates: [] };
              },
            },
          },
          generateClipThumbnailImpl: fakeThumbnailImpl(),
        });
      },
    },
    {
      stage: "ranking",
      run: async (fixture) => {
        const mindsClient = scriptedMindsClient([
          "I would pick the second one.",
          "Still no JSON.",
        ]);
        await runPipeline(fixture.videoId, {
          prismaClient: prisma,
          ingestOptions: fakeIngestOptions(fixture.videoId),
          rankOptions: {
            mindsClient,
          },
          generateClipThumbnailImpl: fakeThumbnailImpl(),
        });
      },
    },
    {
      stage: "captions",
      run: async (fixture) => {
        const mindsClient = scriptedMindsClient([
          JSON.stringify([{ index: 1, reason: "Best." }]),
          "No caption JSON.",
          "Still no caption JSON.",
        ]);
        await runPipeline(fixture.videoId, {
          prismaClient: prisma,
          ingestOptions: fakeIngestOptions(fixture.videoId),
          rankOptions: {
            mindsClient,
          },
          captionOptions: {
            mindsClient,
          },
          generateClipThumbnailImpl: fakeThumbnailImpl(),
        });
      },
    },
  ];

  for (const failureCase of cases) {
    const fixture = await createPipelineFixture();
    try {
      await failureCase.run(fixture);
      const video = await prisma.video.findUniqueOrThrow({
        where: {
          id: fixture.videoId,
        },
        select: {
          pipelineStage: true,
          pipelineError: true,
        },
      });

      assert.equal(video.pipelineStage, "failed");
      assert.match(video.pipelineError ?? "", new RegExp(`^${failureCase.stage}: `));
      assert.equal(video.pipelineError?.includes("\n"), false);
      assert.equal(video.pipelineError?.includes(" at "), false);
    } finally {
      await cleanupFixture(fixture);
    }
  }
});

test("retryPipeline resumes from the failed stage without re-ingesting earlier stages", async () => {
  const fixture = await createPipelineFixture({
    pipelineStage: "failed",
    pipelineError: "ranking: previous Mind outage",
  });
  const transitions: PipelineStage[] = [];
  let ingestCalls = 0;
  const mindsClient = scriptedMindsClient([
    JSON.stringify([{ index: 2, reason: "Retry winner." }]),
    captionReply("Retry first"),
    captionReply("Retry second"),
  ]);

  try {
    await prisma.clip.createMany({
      data: [
        {
          creatorId: fixture.creatorId,
          videoId: fixture.videoId,
          startMs: 1_000,
          endMs: 9_000,
          transcript: "First retry candidate.",
          status: "candidate",
        },
        {
          creatorId: fixture.creatorId,
          videoId: fixture.videoId,
          startMs: 10_000,
          endMs: 20_000,
          transcript: "Second retry candidate.",
          status: "candidate",
        },
      ],
    });

    const result = await retryPipeline(fixture.videoId, {
      prismaClient: prisma,
      ingestUploadedVideoImpl: async () => {
        ingestCalls += 1;
        throw new Error("Retry should not ingest.");
      },
      rankOptions: {
        mindsClient,
      },
      captionOptions: {
        mindsClient,
      },
      generateClipThumbnailImpl: async () => {
        throw new Error("Retry from ranking should not generate thumbnails.");
      },
      onStageChange(stage) {
        transitions.push(stage);
      },
    });

    assert.equal(result.status, "done");
    assert.equal(ingestCalls, 0);
    assert.deepEqual(transitions, ["ranking", "captions", "done"]);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("runPipeline logs thumbnail failures and continues", async () => {
  const fixture = await createPipelineFixture();
  const warnings: string[] = [];
  const mindsClient = scriptedMindsClient([
    JSON.stringify([{ index: 1, reason: "Best despite thumb failure." }]),
    captionReply("Caption after thumb failure"),
    captionReply("Second caption after thumb failure"),
  ]);

  try {
    const result = await runPipeline(fixture.videoId, {
      prismaClient: prisma,
      ingestOptions: fakeIngestOptions(fixture.videoId),
      rankOptions: {
        mindsClient,
      },
      captionOptions: {
        mindsClient,
      },
      generateClipThumbnailImpl: async (clipId) => {
        throw new Error(`thumb failed for ${clipId}`);
      },
      thumbnailLogger: {
        warn(message) {
          warnings.push(message);
        },
      },
    });

    assert.equal(result.status, "done");
    assert.equal(warnings.length, 3);
    assert.equal(
      warnings.every((warning) =>
        warning.startsWith("Thumbnail generation failed for clip "),
      ),
      true,
    );

    const video = await prisma.video.findUniqueOrThrow({
      where: {
        id: fixture.videoId,
      },
      select: {
        pipelineStage: true,
        pipelineError: true,
      },
    });
    assert.equal(video.pipelineStage, "done");
    assert.equal(video.pipelineError, null);
  } finally {
    await cleanupFixture(fixture);
  }
});

function fakeIngestOptions(videoId: string) {
  return {
    storage: fakeStorage(videoId),
    clipServiceClient: fakeClipServiceClient(),
  };
}

function fakeThumbnailImpl(
  calls: string[] = [],
): (
  clipId: string,
  options?: GenerateClipThumbnailOptions,
) => Promise<GenerateClipThumbnailResult> {
  return async (clipId, options) => {
    calls.push(clipId);
    const db = options?.prismaClient ?? prisma;
    const clip = await db.clip.update({
      where: {
        id: clipId,
      },
      data: {
        thumbKey: `thumbs/${clipId}.jpg`,
      },
      select: {
        videoId: true,
      },
    });

    return {
      status: "generated",
      clipId,
      videoId: clip.videoId,
      thumbKey: `thumbs/${clipId}.jpg`,
      thumbUrl: `https://cdn.example/thumbs/${clipId}.jpg`,
    };
  };
}

function fakeStorage(videoId: string): Pick<R2Storage, "presignSourceUrl"> {
  return {
    async presignSourceUrl(key) {
      assert.equal(key, `videos/${videoId}/source.mp4`);
      return `https://signed.example/${key}`;
    },
  };
}

function fakeClipServiceClient(): ClipServiceClient {
  return {
    async fetchCandidates(source) {
      assert.equal(source.kind, "url");
      assert.match(source.sourceUrl, /^https:\/\/signed\.example\/videos\//);

      return {
        candidates: [
          {
            startMs: 1_000,
            endMs: 11_000,
            transcript: "Clean setup.",
            reasons: ["setup"],
          },
          {
            startMs: 12_000,
            endMs: 24_000,
            transcript: "Wait for the turn.",
            reasons: ["turn"],
          },
          {
            startMs: 25_000,
            endMs: 37_000,
            transcript: "Extra useful moment.",
            reasons: ["extra"],
          },
        ],
      };
    },
  };
}

function scriptedMindsClient(replies: string[]) {
  return {
    async sendMessageAndWaitForReply() {
      const reply = replies.shift();
      if (reply === undefined) {
        throw new Error("No fake Mind reply queued.");
      }

      return reply;
    },
  };
}

function captionReply(label: string): string {
  return JSON.stringify({
    youtube: `${label} title`,
    tiktok: `${label} for TikTok #clipmind`,
    instagram: `${label} on Instagram. Extra context here\n\n#clipmind`,
  });
}

async function createPipelineFixture(
  overrides: {
    pipelineStage?: string;
    pipelineError?: string | null;
  } = {},
): Promise<PipelineFixture> {
  const marker = `pipeline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const creator = await prisma.creator.create({
    data: {
      accessCode: `${marker}-code`,
      channelUrl: `https://example.com/${marker}`,
      mindId: `mind-${marker}`,
      captionStyle: {
        preset: "clean-bold",
      },
    },
  });
  const video = await prisma.video.create({
    data: {
      creatorId: creator.id,
      contentKey: `${marker}-content`,
      sourceKey: `videos/${marker}/source.mp4`,
      sourceUrl: null,
      status: "uploaded",
      pipelineStage: overrides.pipelineStage ?? "uploaded",
      pipelineError: overrides.pipelineError ?? null,
    },
  });

  await prisma.video.update({
    where: {
      id: video.id,
    },
    data: {
      sourceKey: `videos/${video.id}/source.mp4`,
    },
  });

  return {
    creatorId: creator.id,
    videoId: video.id,
  };
}

async function cleanupFixture(fixture: PipelineFixture): Promise<void> {
  await prisma.schedule.deleteMany({
    where: {
      creatorId: fixture.creatorId,
    },
  });
  await prisma.clip.deleteMany({
    where: {
      creatorId: fixture.creatorId,
    },
  });
  await prisma.video.deleteMany({
    where: {
      creatorId: fixture.creatorId,
    },
  });
  await prisma.creator.delete({
    where: {
      id: fixture.creatorId,
    },
  });
}
