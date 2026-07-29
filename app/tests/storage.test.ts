import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { requireStorageEnv } from "../lib/env";
import { onboardCreator, type OnboardingRepository } from "../lib/onboarding";
import { computeNextSlot } from "../lib/scheduling";
import {
  createR2Storage,
  deleteMediaObject,
  deleteSourceObject,
  publicMediaKeyFromUrl,
  publicMediaUrlForKey,
  renderKeyForClip,
  sourceKeyForVideo,
  thumbnailKeyForClip,
  type S3ClientLike,
} from "../lib/storage";
import type { InitialTenets } from "../lib/tenets";

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
    ContentType?: unknown;
  };
};

test("storage uses stable source and render key layout", async () => {
  const sentCommands: RecordedCommand[] = [];
  const s3Client = {
    async send(command) {
      sentCommands.push(recordCommand(command));
      return {};
    },
  } satisfies S3ClientLike;
  let presignedCommand: RecordedCommand | null = null;
  let presignedTtl: number | null = null;

  const storage = createR2Storage({
    env: storageEnv,
    s3Client,
    async presignSource(client, command, expiresInSeconds) {
      assert.equal(client, s3Client);
      presignedCommand = recordCommand(command);
      presignedTtl = expiresInSeconds;
      return "https://signed.example/source.mp4";
    },
  });

  const sourceKey = await storage.uploadSource(
    "video_123",
    Readable.from(Buffer.from("source")),
  );
  const signedUrl = await storage.presignSourceUrl(sourceKey);
  const renderedUrl = await storage.uploadRender(
    "clip_456",
    Readable.from(Buffer.from("rendered")),
  );
  const thumbKey = await storage.uploadThumbnail(
    "clip_789",
    Readable.from(Buffer.from("jpeg")),
  );

  assert.equal(sourceKey, sourceKeyForVideo("video_123"));
  assert.equal(sourceKey, "videos/video_123/source.mp4");
  assert.equal(signedUrl, "https://signed.example/source.mp4");
  assert.equal(presignedTtl, 3_600);
  assert.ok(presignedCommand);
  assert.deepEqual(recordCommand(presignedCommand).input, {
    Bucket: "clipmind-sources",
    Key: "videos/video_123/source.mp4",
  });
  assert.equal(renderKeyForClip("clip_456"), "clips/clip_456.mp4");
  assert.equal(renderedUrl, "https://cdn.example/clips/clip_456.mp4");
  assert.equal(thumbnailKeyForClip("clip_789"), "thumbs/clip_789.jpg");
  assert.equal(thumbKey, "thumbs/clip_789.jpg");
  assert.equal(
    publicMediaUrlForKey(thumbKey, "https://cdn.example/"),
    "https://cdn.example/thumbs/clip_789.jpg",
  );
  assert.equal(
    publicMediaKeyFromUrl(
      "https://cdn.example/clips/clip_456.mp4?cache=1",
      "https://cdn.example/",
    ),
    "clips/clip_456.mp4",
  );
  assert.equal(
    publicMediaKeyFromUrl(
      "https://elsewhere.example/clips/clip_456.mp4",
      "https://cdn.example",
    ),
    null,
  );
  assert.equal(sentCommands.length, 3);
  assert.equal(sentCommands[0]?.input.Bucket, "clipmind-sources");
  assert.equal(sentCommands[0]?.input.Key, "videos/video_123/source.mp4");
  assert.equal(sentCommands[0]?.input.ContentType, "video/mp4");
  assert.equal(sentCommands[1]?.input.Bucket, "clipmind-media");
  assert.equal(sentCommands[1]?.input.Key, "clips/clip_456.mp4");
  assert.equal(sentCommands[1]?.input.ContentType, "video/mp4");
  assert.equal(sentCommands[2]?.input.Bucket, "clipmind-media");
  assert.equal(sentCommands[2]?.input.Key, "thumbs/clip_789.jpg");
  assert.equal(sentCommands[2]?.input.ContentType, "image/jpeg");
});

test("storage deletes source and media objects through the configured buckets", async () => {
  const sentCommands: RecordedCommand[] = [];
  const s3Client = {
    async send(command) {
      sentCommands.push(recordCommand(command));
      return {};
    },
  } satisfies S3ClientLike;

  await deleteSourceObject("videos/video_123/source.mp4", {
    env: storageEnv,
    s3Client,
  });
  await deleteMediaObject("clips/clip_456.mp4", {
    env: storageEnv,
    s3Client,
  });

  assert.deepEqual(
    sentCommands.map((command) => command.input),
    [
      {
        Bucket: "clipmind-sources",
        Key: "videos/video_123/source.mp4",
      },
      {
        Bucket: "clipmind-media",
        Key: "clips/clip_456.mp4",
      },
    ],
  );
});

test("storage delete tolerates missing objects", async () => {
  const s3Client = {
    async send() {
      const error = new Error("Object is already gone.") as Error & {
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

  await assert.doesNotReject(
    deleteMediaObject("clips/missing.mp4", {
      env: storageEnv,
      s3Client,
    }),
  );
});

test("storage env validation is lazy and scoped to R2 variables", () => {
  assert.throws(
    () => requireStorageEnv({}),
    /R2 storage env missing required variables: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_SOURCES_BUCKET, R2_MEDIA_BUCKET, R2_MEDIA_PUBLIC_BASE/,
  );

  assert.deepEqual(requireStorageEnv(storageEnv), storageEnv);
});

test("missing R2 env does not block onboarding or scheduling code paths", async () => {
  const savedEnv = unsetR2Env();

  try {
    assert.equal(
      computeNextSlot(
        { slotsPerDay: 1, lastScheduledAt: null },
        new Date("2026-07-28T08:00:00.000Z"),
      ).toISOString(),
      "2026-07-28T09:00:00.000Z",
    );

    const result = await onboardCreator({
      creatorId: "creator_without_r2",
      corpusItems: [
        {
          source: "sample.mp4",
          sourceType: "source_video",
          weight: 1,
        },
      ],
      repository: recordingRepository("creator_without_r2"),
      transcribeItem: async () => ({
        text: "This path does not use R2.",
        segments: [],
        words: [],
      }),
      distillTenets: async () => tenets,
      mindsClient: null,
    });

    assert.equal(result.status, "DEFERRED");
    assert.equal(result.creatorId, "creator_without_r2");
  } finally {
    restoreR2Env(savedEnv);
  }
});

function recordCommand(command: unknown): RecordedCommand {
  return command as RecordedCommand;
}

const tenets: InitialTenets = {
  version: "voice-distill-v1",
  generatedAt: "2026-07-28T00:00:00.000Z",
  voiceProfile: {
    sentenceStructure: ["Short setup, then payoff."],
    phrasingHabits: ["Uses wait to focus attention."],
    hookStyle: ["Opens on the moment."],
    vocabulary: ["wait", "moment"],
  },
  clipTasteProfile: {
    preferredMoments: ["Clear turns."],
    pacing: ["Fast payoff."],
    emotionalSignals: ["Surprise."],
    clipPatterns: ["Setup, turn, reaction."],
  },
  guardrails: ["Keep it plain."],
};

function recordingRepository(creatorId: string): OnboardingRepository {
  return {
    async ensureCreator() {
      return { id: creatorId };
    },
    async saveMindId() {},
    async saveInitialTenets() {},
    async saveMindIdAndInitialTenets() {},
  };
}

function unsetR2Env(): Map<string, string | undefined> {
  const names = Object.keys(storageEnv);
  const saved = new Map<string, string | undefined>();
  for (const name of names) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  return saved;
}

function restoreR2Env(saved: Map<string, string | undefined>): void {
  for (const [name, value] of saved) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
