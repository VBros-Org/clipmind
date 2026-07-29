import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { prisma } from "../lib/db";
import { cookieHeaderForAccessCode } from "../lib/review-auth";
import {
  handleDeleteVideo,
  handleGetRecentUploads,
  handleGetVideoStatus,
  handleRetryVideo,
  handleUploadVideo,
} from "../lib/video-api";
import { loadHomeOverview } from "../lib/app-overview";
import {
  createR2Storage,
  type R2Storage,
  type S3ClientLike,
  type StorageUploadBody,
} from "../lib/storage";

type VideoApiFixture = {
  creatorAId: string;
  creatorBId: string;
  creatorACode: string;
  creatorBCode: string;
  videoId?: string;
};

const storageEnv = {
  R2_ACCOUNT_ID: "account-id",
  R2_ACCESS_KEY_ID: "access-key",
  R2_SECRET_ACCESS_KEY: "secret-key",
  R2_SOURCES_BUCKET: "clipmind-sources",
  R2_MEDIA_BUCKET: "clipmind-media",
  R2_MEDIA_PUBLIC_BASE: "https://cdn.example",
};

type RecordedCommand = {
  input: {
    Bucket?: unknown;
    Key?: unknown;
  };
};

test("upload route rejects missing auth before reading the multipart body", async () => {
  const response = await handleUploadVideo(
    new Request("http://localhost/api/videos/upload", {
      method: "POST",
    }),
    {
      storage: {
        async uploadSource() {
          throw new Error("Unauthenticated upload should not reach storage.");
        },
      },
    },
  );

  assert.equal(response.status, 401);
});

test("upload route streams one authenticated video to R2, creates a Video row, and starts the pipeline", async () => {
  const fixture = await createFixture();
  const uploadedBodies: string[] = [];
  const runCalls: string[] = [];

  try {
    const form = new FormData();
    form.set(
      "file",
      new Blob([Buffer.from("fake-video-body")], {
        type: "video/mp4",
      }),
      "sample.mp4",
    );

    const response = await handleUploadVideo(
      new Request("http://localhost/api/videos/upload", {
        method: "POST",
        body: form,
        headers: {
          cookie: cookieHeaderForAccessCode(fixture.creatorACode),
          "x-clipmind-file-size": String(Buffer.byteLength("fake-video-body")),
        },
      }),
      {
        storage: {
          async uploadSource(videoId, source) {
            uploadedBodies.push(await readUploadBody(source));
            return `videos/${videoId}/source.mp4`;
          },
        } satisfies Pick<R2Storage, "uploadSource">,
        async runPipelineImpl(videoId) {
          runCalls.push(videoId);
          return {
            status: "done",
            videoId,
            creatorId: fixture.creatorAId,
            clipCount: 0,
            captionedClipIds: [],
          };
        },
      },
    );

    assert.equal(response.status, 202);
    const body = (await response.json()) as {
      videoId: string;
      stage: string;
      bytes: number;
    };
    fixture.videoId = body.videoId;
    assert.equal(body.stage, "uploaded");
    assert.equal(body.bytes, Buffer.byteLength("fake-video-body"));
    assert.deepEqual(uploadedBodies, ["fake-video-body"]);
    assert.deepEqual(runCalls, [body.videoId]);

    const video = await prisma.video.findUniqueOrThrow({
      where: {
        id: body.videoId,
      },
      select: {
        creatorId: true,
        sourceKey: true,
        contentKey: true,
        status: true,
        pipelineStage: true,
        pipelineError: true,
      },
    });

    assert.equal(video.creatorId, fixture.creatorAId);
    assert.equal(video.sourceKey, `videos/${body.videoId}/source.mp4`);
    assert.equal(video.contentKey, `uploaded:${fixture.creatorAId}:${body.videoId}`);
    assert.equal(video.status, "uploaded");
    assert.equal(video.pipelineStage, "uploaded");
    assert.equal(video.pipelineError, null);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("status endpoint requires auth and creator scoping", async () => {
  const fixture = await createFixture();

  try {
    const video = await createVideo(fixture, {
      pipelineStage: "captions",
      clipCount: 2,
    });
    fixture.videoId = video.id;

    const noCookie = await handleGetVideoStatus(
      new Request(`http://localhost/api/videos/${video.id}/status`),
      { id: video.id },
    );
    assert.equal(noCookie.status, 401);

    const crossCreator = await handleGetVideoStatus(
      requestWithCode(video.id, fixture.creatorBCode),
      { id: video.id },
    );
    assert.equal(crossCreator.status, 404);

    const ownVideo = await handleGetVideoStatus(
      requestWithCode(video.id, fixture.creatorACode),
      { id: video.id },
    );
    assert.equal(ownVideo.status, 200);
    assert.equal(ownVideo.headers.get("cache-control"), "no-store");
    assert.deepEqual(await ownVideo.json(), {
      stage: "captions",
      error: null,
      failedStage: null,
      clipCount: 2,
    });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("recent uploads endpoint is creator scoped and no-store", async () => {
  const fixture = await createFixture();

  try {
    const video = await createVideo(fixture, {
      pipelineStage: "failed",
      pipelineError: "transcribing: Whisper timeout",
      clipCount: 0,
    });
    fixture.videoId = video.id;

    const noCookie = await handleGetRecentUploads(
      new Request("http://localhost/api/videos/recent"),
    );
    assert.equal(noCookie.status, 401);
    assert.equal(noCookie.headers.get("cache-control"), "no-store");

    const response = await handleGetRecentUploads(
      requestForPath("/api/videos/recent", fixture.creatorACode),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");

    const body = (await response.json()) as {
      uploads: Array<{
        id: string;
        pipelineStage: string;
        pipelineError: string | null;
        clipCount: number;
      }>;
    };
    assert.equal(body.uploads.length, 1);
    assert.equal(body.uploads[0]?.id, video.id);
    assert.equal(body.uploads[0]?.pipelineStage, "failed");
    assert.equal(body.uploads[0]?.pipelineError, "transcribing: Whisper timeout");
    assert.equal(body.uploads[0]?.clipCount, 0);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("delete video returns posted guard and does not delete storage or rows", async () => {
  const fixture = await createFixture();
  let storageCalls = 0;

  try {
    const video = await prisma.video.create({
      data: {
        creatorId: fixture.creatorAId,
        contentKey: `posted-guard-${Date.now()}`,
        sourceKey: "videos/posted-guard/source.mp4",
        status: "clipped",
        pipelineStage: "done",
      },
      select: {
        id: true,
      },
    });
    fixture.videoId = video.id;
    await prisma.clip.create({
      data: {
        creatorId: fixture.creatorAId,
        videoId: video.id,
        startMs: 0,
        endMs: 10_000,
        status: "posted",
        postedAt: new Date("2026-07-29T10:00:00.000Z"),
      },
    });

    const response = await handleDeleteVideo(
      requestForPath(`/api/videos/${video.id}`, fixture.creatorACode, "DELETE"),
      { id: video.id },
      {
        deleteStorage: {
          async deleteSource() {
            storageCalls += 1;
          },
          async deleteMediaObject() {
            storageCalls += 1;
          },
        },
      },
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      reason: "posted history",
      error: "This video has posted clips. Posted history cannot be deleted.",
    });
    assert.equal(storageCalls, 0);
    assert.equal(
      await prisma.video.count({
        where: {
          id: video.id,
        },
      }),
      1,
    );
    assert.equal(
      await prisma.clip.count({
        where: {
          videoId: video.id,
        },
      }),
      1,
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test("delete video cascades rows, deletes R2 objects, and clears Home ready rows", async () => {
  const fixture = await createFixture();
  const savedMediaBase = process.env.R2_MEDIA_PUBLIC_BASE;
  process.env.R2_MEDIA_PUBLIC_BASE = storageEnv.R2_MEDIA_PUBLIC_BASE;
  const deletedObjects: Array<{ Bucket?: unknown; Key?: unknown }> = [];
  const s3Client = {
    async send(command) {
      deletedObjects.push(recordCommand(command).input);
      return {};
    },
  } satisfies S3ClientLike;

  try {
    await prisma.schedule.create({
      data: {
        creatorId: fixture.creatorAId,
        slots: [],
        rotation: {},
        slotsPerDay: 2,
        anchorHour: 9,
      },
    });
    const video = await prisma.video.create({
      data: {
        creatorId: fixture.creatorAId,
        contentKey: `delete-cascade-${Date.now()}`,
        sourceKey: "videos/delete-cascade/source.mp4",
        status: "clipped",
        pipelineStage: "done",
      },
      select: {
        id: true,
      },
    });
    fixture.videoId = video.id;
    const clipA = await prisma.clip.create({
      data: {
        creatorId: fixture.creatorAId,
        videoId: video.id,
        startMs: 0,
        endMs: 8_000,
        renderedUrl: "https://cdn.example/clips/delete-a.mp4",
        thumbKey: "thumbs/delete-a.jpg",
        postCopyVariants: {
          youtube: "Clip A",
          tiktok: "Clip A #clipmind",
          instagram: "Clip A\n\n#clipmind",
        },
        status: "scheduled",
        scheduledFor: new Date("2026-07-29T12:00:00.000Z"),
      },
      select: {
        id: true,
      },
    });
    const clipB = await prisma.clip.create({
      data: {
        creatorId: fixture.creatorAId,
        videoId: video.id,
        startMs: 10_000,
        endMs: 18_000,
        renderedUrl: "https://cdn.example/clips/delete-b.mp4",
        thumbKey: "thumbs/delete-b.jpg",
        status: "candidate",
      },
      select: {
        id: true,
      },
    });
    await prisma.learningEvent.createMany({
      data: [
        {
          clipId: clipA.id,
          creatorId: fixture.creatorAId,
          action: "accept",
        },
        {
          clipId: clipB.id,
          creatorId: fixture.creatorAId,
          action: "reject",
        },
      ],
    });

    const beforeHome = await loadHomeOverview(fixture.creatorAId);
    assert.equal(beforeHome.readyToPost.length, 1);
    assert.equal(beforeHome.runway.clipCount, 1);

    const response = await handleDeleteVideo(
      requestForPath(`/api/videos/${video.id}`, fixture.creatorACode, "DELETE"),
      { id: video.id },
      {
        deleteStorage: createR2Storage({
          env: storageEnv,
          s3Client,
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      videoId: video.id,
      deleted: {
        learningEvents: 2,
        clips: 2,
        videos: 1,
        objects: 5,
      },
    });
    assert.deepEqual(deletedObjects, [
      {
        Bucket: "clipmind-sources",
        Key: "videos/delete-cascade/source.mp4",
      },
      {
        Bucket: "clipmind-media",
        Key: "clips/delete-a.mp4",
      },
      {
        Bucket: "clipmind-media",
        Key: "thumbs/delete-a.jpg",
      },
      {
        Bucket: "clipmind-media",
        Key: "clips/delete-b.mp4",
      },
      {
        Bucket: "clipmind-media",
        Key: "thumbs/delete-b.jpg",
      },
    ]);
    assert.equal(
      await prisma.video.count({
        where: {
          id: video.id,
        },
      }),
      0,
    );
    assert.equal(
      await prisma.clip.count({
        where: {
          videoId: video.id,
        },
      }),
      0,
    );
    assert.equal(
      await prisma.learningEvent.count({
        where: {
          clipId: {
            in: [clipA.id, clipB.id],
          },
        },
      }),
      0,
    );

    const afterHome = await loadHomeOverview(fixture.creatorAId);
    assert.equal(afterHome.readyToPost.length, 0);
    assert.equal(afterHome.runway.clipCount, 0);
  } finally {
    restoreEnvValue("R2_MEDIA_PUBLIC_BASE", savedMediaBase);
    await cleanupFixture(fixture);
  }
});

test("delete video is creator scoped", async () => {
  const fixture = await createFixture();
  let storageCalls = 0;

  try {
    const video = await createVideo(fixture, {
      pipelineStage: "done",
      clipCount: 1,
    });
    fixture.videoId = video.id;

    const response = await handleDeleteVideo(
      requestForPath(`/api/videos/${video.id}`, fixture.creatorBCode, "DELETE"),
      { id: video.id },
      {
        deleteStorage: {
          async deleteSource() {
            storageCalls += 1;
          },
          async deleteMediaObject() {
            storageCalls += 1;
          },
        },
      },
    );

    assert.equal(response.status, 404);
    assert.equal(storageCalls, 0);
    assert.equal(
      await prisma.video.count({
        where: {
          id: video.id,
        },
      }),
      1,
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test("delete video tolerates missing R2 objects", async () => {
  const fixture = await createFixture();
  const savedMediaBase = process.env.R2_MEDIA_PUBLIC_BASE;
  process.env.R2_MEDIA_PUBLIC_BASE = storageEnv.R2_MEDIA_PUBLIC_BASE;
  const attemptedKeys: unknown[] = [];
  const s3Client = {
    async send(command) {
      const input = recordCommand(command).input;
      attemptedKeys.push(input.Key);
      const error = new Error(`Missing ${String(input.Key)}`) as Error & {
        name: string;
        $metadata: {
          httpStatusCode: number;
        };
      };
      error.name = "NoSuchKey";
      error.$metadata = {
        httpStatusCode: 404,
      };
      throw error;
    },
  } satisfies S3ClientLike;

  try {
    const video = await prisma.video.create({
      data: {
        creatorId: fixture.creatorAId,
        contentKey: `missing-r2-${Date.now()}`,
        sourceKey: "videos/missing-r2/source.mp4",
        status: "clipped",
        pipelineStage: "done",
      },
      select: {
        id: true,
      },
    });
    fixture.videoId = video.id;
    await prisma.clip.create({
      data: {
        creatorId: fixture.creatorAId,
        videoId: video.id,
        startMs: 0,
        endMs: 8_000,
        renderedUrl: "https://cdn.example/clips/missing-r2.mp4",
        thumbKey: "thumbs/missing-r2.jpg",
        status: "candidate",
      },
    });

    const response = await handleDeleteVideo(
      requestForPath(`/api/videos/${video.id}`, fixture.creatorACode, "DELETE"),
      { id: video.id },
      {
        deleteStorage: createR2Storage({
          env: storageEnv,
          s3Client,
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(attemptedKeys, [
      "videos/missing-r2/source.mp4",
      "clips/missing-r2.mp4",
      "thumbs/missing-r2.jpg",
    ]);
    assert.equal(
      await prisma.video.count({
        where: {
          id: video.id,
        },
      }),
      0,
    );
    assert.equal(
      await prisma.clip.count({
        where: {
          videoId: video.id,
        },
      }),
      0,
    );
  } finally {
    restoreEnvValue("R2_MEDIA_PUBLIC_BASE", savedMediaBase);
    await cleanupFixture(fixture);
  }
});

test("retry endpoint is creator scoped and starts a failed-stage retry in the background", async () => {
  const fixture = await createFixture();
  const retryCalls: string[] = [];

  try {
    const video = await createVideo(fixture, {
      pipelineStage: "failed",
      pipelineError: "ranking: Mind timeout",
      clipCount: 1,
    });
    fixture.videoId = video.id;

    const crossCreator = await handleRetryVideo(
      requestWithCode(video.id, fixture.creatorBCode, "POST"),
      { id: video.id },
      {
        async retryPipelineImpl() {
          throw new Error("Cross creator retry should not run.");
        },
      },
    );
    assert.equal(crossCreator.status, 404);

    const response = await handleRetryVideo(
      requestWithCode(video.id, fixture.creatorACode, "POST"),
      { id: video.id },
      {
        async retryPipelineImpl(videoId) {
          retryCalls.push(videoId);
          return {
            status: "done",
            videoId,
            creatorId: fixture.creatorAId,
            clipCount: 1,
            captionedClipIds: [],
          };
        },
      },
    );

    assert.equal(response.status, 202);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      videoId: video.id,
      retrying: true,
      stage: "ranking",
    });
    assert.deepEqual(retryCalls, [video.id]);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("retry endpoint is creator scoped for failed Mind onboarding", async () => {
  const fixture = await createFixture();
  const retryCalls: string[] = [];

  try {
    const video = await createVideo(fixture, {
      pipelineStage: "uploaded",
      clipCount: 0,
    });
    fixture.videoId = video.id;
    await prisma.creator.update({
      where: {
        id: fixture.creatorAId,
      },
      data: {
        mindId: null,
        mindStage: "failed",
        mindError: "waking_mind: Mind creation timed out",
      },
    });

    const crossCreator = await handleRetryVideo(
      requestWithCode(video.id, fixture.creatorBCode, "POST"),
      { id: video.id },
      {
        async runFirstVideoOnboardingPipelineImpl() {
          throw new Error("Cross creator Mind retry should not run.");
        },
      },
    );
    assert.equal(crossCreator.status, 404);

    const response = await handleRetryVideo(
      requestWithCode(video.id, fixture.creatorACode, "POST"),
      { id: video.id },
      {
        async runFirstVideoOnboardingPipelineImpl(videoId) {
          retryCalls.push(videoId);
          return {
            status: "failed",
            videoId,
            creatorId: fixture.creatorAId,
            failedStage: "waking_mind",
            error: "waking_mind: Mind creation timed out",
          };
        },
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      videoId: video.id,
      retrying: true,
      stage: "waking_mind",
    });
    assert.deepEqual(retryCalls, [video.id]);
  } finally {
    await cleanupFixture(fixture);
  }
});

async function createFixture(): Promise<VideoApiFixture> {
  const marker = `video-api-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const creatorA = await prisma.creator.create({
    data: {
      accessCode: `${marker}-a`,
      channelUrl: `https://example.com/${marker}/a`,
      mindId: `mind-${marker}-a`,
    },
  });
  const creatorB = await prisma.creator.create({
    data: {
      accessCode: `${marker}-b`,
      channelUrl: `https://example.com/${marker}/b`,
      mindId: `mind-${marker}-b`,
    },
  });

  return {
    creatorAId: creatorA.id,
    creatorBId: creatorB.id,
    creatorACode: creatorA.accessCode ?? "",
    creatorBCode: creatorB.accessCode ?? "",
  };
}

async function createVideo(
  fixture: VideoApiFixture,
  args: {
    pipelineStage: string;
    pipelineError?: string | null;
    clipCount: number;
  },
) {
  const marker = `video-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const video = await prisma.video.create({
    data: {
      creatorId: fixture.creatorAId,
      contentKey: `${marker}-content`,
      sourceKey: `videos/${marker}/source.mp4`,
      status: "clipped",
      pipelineStage: args.pipelineStage,
      pipelineError: args.pipelineError ?? null,
    },
  });

  for (let index = 0; index < args.clipCount; index += 1) {
    await prisma.clip.create({
      data: {
        creatorId: fixture.creatorAId,
        videoId: video.id,
        startMs: index * 10_000,
        endMs: index * 10_000 + 8_000,
        transcript: `Clip ${index + 1}`,
        status: "candidate",
      },
    });
  }

  return video;
}

async function cleanupFixture(fixture: VideoApiFixture): Promise<void> {
  await prisma.schedule.deleteMany({
    where: {
      creatorId: {
        in: [fixture.creatorAId, fixture.creatorBId],
      },
    },
  });
  await prisma.learningEvent.deleteMany({
    where: {
      creatorId: {
        in: [fixture.creatorAId, fixture.creatorBId],
      },
    },
  });
  await prisma.clip.deleteMany({
    where: {
      creatorId: {
        in: [fixture.creatorAId, fixture.creatorBId],
      },
    },
  });
  await prisma.video.deleteMany({
    where: {
      creatorId: {
        in: [fixture.creatorAId, fixture.creatorBId],
      },
    },
  });
  await prisma.creator.deleteMany({
    where: {
      id: {
        in: [fixture.creatorAId, fixture.creatorBId],
      },
    },
  });
}

function requestWithCode(
  videoId: string,
  accessCode: string,
  method = "GET",
): Request {
  return requestForPath(`/api/videos/${videoId}/status`, accessCode, method);
}

function requestForPath(
  path: string,
  accessCode: string,
  method = "GET",
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      cookie: cookieHeaderForAccessCode(accessCode),
    },
  });
}

async function readUploadBody(source: StorageUploadBody): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of source as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function recordCommand(command: unknown): RecordedCommand {
  return command as RecordedCommand;
}

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
