import test from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../lib/db";
import { ClipServiceApiError, type ChannelVideo } from "../lib/clip-service";
import {
  CHANNEL_PULL_MAX_VIDEO_DURATION_S,
  ChannelPullInputError,
  buildChannelPullReseedAlias,
  channelPullStatusResponse,
  normalizeYouTubeChannelInput,
  pullChannelVoice,
  selectChannelVideosForVoice,
  type ChannelPullClipServiceClient,
  type ChannelPullOptions,
} from "../lib/channelPull";
import { YT_BLOCKED_CHANNEL_PULL_MESSAGE } from "../lib/channel-pull-status";
import type { MindsClient } from "../lib/minds";
import type { InitialTenets } from "../lib/tenets";
import type { Transcript } from "../lib/transcript";

const tenets: InitialTenets = {
  version: "voice-distill-v1",
  generatedAt: "2026-07-30T00:00:00.000Z",
  voiceProfile: {
    sentenceStructure: ["Short setup, direct payoff."],
    phrasingHabits: ["Uses bro as emphasis."],
    hookStyle: ["Starts with the stakes."],
    vocabulary: ["bro", "saved"],
  },
  clipTasteProfile: {
    preferredMoments: ["Unexpected saves."],
    pacing: ["Fast setup and payoff."],
    emotionalSignals: ["Disbelief and relief."],
    clipPatterns: ["Quiet setup, sudden turn, reaction."],
  },
  guardrails: ["Keep the voice casual."],
};

const channelVideos: ChannelVideo[] = [
  {
    videoId: "video-1",
    title: "Recent short",
    durationS: 240,
    url: "https://www.youtube.com/watch?v=video-1",
  },
  {
    videoId: "video-too-long",
    title: "Long VOD",
    durationS: 1_500,
    url: "https://www.youtube.com/watch?v=video-too-long",
  },
  {
    videoId: "video-2",
    title: "Second short",
    durationS: 61,
    url: "https://www.youtube.com/watch?v=video-2",
  },
  {
    videoId: "video-3",
    title: "Third short",
    durationS: 1_199,
    url: "https://www.youtube.com/watch?v=video-3",
  },
];

test("channel input validation accepts YouTube handles and rejects other platforms", () => {
  assert.equal(
    normalizeYouTubeChannelInput("@MrBeast"),
    "https://www.youtube.com/@MrBeast",
  );
  assert.equal(
    normalizeYouTubeChannelInput("youtube.com/@MrBeast/videos"),
    "https://www.youtube.com/@MrBeast",
  );

  assert.throws(
    () => normalizeYouTubeChannelInput("https://www.tiktok.com/@mrbeast"),
    (error) =>
      error instanceof ChannelPullInputError &&
      error.status === 422 &&
      error.message === "YouTube only for now.",
  );
});

test("selectChannelVideosForVoice picks up to three recent videos under the cap", () => {
  assert.deepEqual(
    selectChannelVideosForVoice([
      ...channelVideos,
      {
        videoId: "unknown-duration",
        title: "Unknown",
        durationS: null,
        url: "https://www.youtube.com/watch?v=unknown-duration",
      },
    ]).map((video) => video.videoId),
    ["video-1", "video-2", "video-3"],
  );
});

test("pullChannelVoice progresses stages, merges captions, first-video transcript, and channel transcripts", async () => {
  const fixture = await createFixture();
  const transitions: string[] = [];
  const mindsClient = recordingMindsClient("Stored recent channel voice.");
  const transcribeCalls: Array<{ url: string; maxDurationS: number }> = [];

  try {
    const result = await pullChannelVoice(fixture.creatorId, {
      prismaClient: prisma,
      channelUrl: "@MrBeast",
      clipServiceClient: {
        async listChannel(channelUrl) {
          assert.equal(channelUrl, "https://www.youtube.com/@MrBeast");
          return channelVideos;
        },
        async transcribeRemote(videoUrl, maxDurationS) {
          transcribeCalls.push({ url: videoUrl, maxDurationS });
          return transcript(`transcript for ${videoUrl}`);
        },
      },
      async distillTenets(transcripts, evidence) {
        assert.equal(evidence?.captionCorpus, fixture.captionCorpus);
        assert.equal(transcripts.length, 4);
        assert.equal(transcripts[0]?.source.startsWith("clip:"), true);
        assert.equal(transcripts[0]?.transcript.text, fixture.firstVideoTranscript);
        assert.deepEqual(
          transcripts.slice(1).map((item) => item.source),
          ["youtube:video-1", "youtube:video-2", "youtube:video-3"],
        );
        return tenets;
      },
      mindsClient,
      now: new Date("2026-07-30T10:00:00.000Z"),
      onStageChange(stage) {
        transitions.push(stage);
      },
    });

    assert.equal(result.status, "done");
    assert.deepEqual(transitions, [
      "listing",
      "transcribing_1",
      "transcribing_2",
      "transcribing_3",
      "distilling",
      "seeding",
      "done",
    ]);
    assert.deepEqual(
      transcribeCalls.map((call) => ({
        id: new URL(call.url).searchParams.get("v"),
        maxDurationS: call.maxDurationS,
      })),
      [
        { id: "video-1", maxDurationS: CHANNEL_PULL_MAX_VIDEO_DURATION_S },
        { id: "video-2", maxDurationS: CHANNEL_PULL_MAX_VIDEO_DURATION_S },
        { id: "video-3", maxDurationS: CHANNEL_PULL_MAX_VIDEO_DURATION_S },
      ],
    );
    assert.deepEqual(mindsClient.addOptions, {
      alias: buildChannelPullReseedAlias(
        fixture.creatorId,
        new Date("2026-07-30T10:00:00.000Z"),
      ),
      action: "Channel pull Tenet seed",
    });

    const creator = await prisma.creator.findUniqueOrThrow({
      where: {
        id: fixture.creatorId,
      },
      select: {
        channelUrl: true,
        channelPullStage: true,
        channelPullError: true,
        initialTenets: true,
      },
    });
    assert.equal(creator.channelUrl, "https://www.youtube.com/@MrBeast");
    assert.equal(creator.channelPullStage, "done");
    assert.equal(creator.channelPullError, null);
    assert.deepEqual(creator.initialTenets, tenets);
  } finally {
    await cleanupFixture(fixture.creatorId);
  }
});

test("pullChannelVoice stores failed stage for each orchestration failure", async () => {
  const cases: Array<{
    name: string;
    failedStage: string;
    options: (fixture: ChannelPullFixture) => Partial<ChannelPullOptions>;
  }> = [
    {
      name: "listing",
      failedStage: "listing",
      options: () => ({
        clipServiceClient: {
          async listChannel() {
            throw new Error("list failed");
          },
          async transcribeRemote() {
            throw new Error("transcribe should not run");
          },
        },
      }),
    },
    {
      name: "transcribing",
      failedStage: "transcribing_1",
      options: () => ({
        clipServiceClient: fakeClipService({
          async transcribeRemote() {
            throw new Error("transcribe failed");
          },
        }),
      }),
    },
    {
      name: "distilling",
      failedStage: "distilling",
      options: () => ({
        clipServiceClient: fakeClipService(),
        async distillTenets() {
          throw new Error("distill failed");
        },
      }),
    },
    {
      name: "seeding",
      failedStage: "seeding",
      options: () => ({
        clipServiceClient: fakeClipService(),
        async distillTenets() {
          return tenets;
        },
        mindsClient: recordingMindsClient("unused", {
          addTenetsError: new Error("seed failed"),
        }),
      }),
    },
  ];

  for (const failureCase of cases) {
    const fixture = await createFixture({
      markerSuffix: failureCase.name,
    });
    const transitions: string[] = [];
    try {
      const result = await pullChannelVoice(fixture.creatorId, {
        prismaClient: prisma,
        channelUrl: "@MrBeast",
        async distillTenets() {
          return tenets;
        },
        mindsClient: recordingMindsClient("Stored."),
        onStageChange(stage) {
          transitions.push(stage);
        },
        ...failureCase.options(fixture),
      });

      assert.equal(result.status, "failed");
      assert.equal(result.failedStage, failureCase.failedStage);
      assert.equal(transitions.at(-1), "failed");

      const creator = await prisma.creator.findUniqueOrThrow({
        where: {
          id: fixture.creatorId,
        },
        select: {
          channelPullStage: true,
          channelPullError: true,
        },
      });
      assert.equal(creator.channelPullStage, "failed");
      assert.match(creator.channelPullError ?? "", new RegExp(`^${failureCase.failedStage}: `));
    } finally {
      await cleanupFixture(fixture.creatorId);
    }
  }
});

test("pullChannelVoice records yt_blocked and status response returns friendly copy", async () => {
  const fixture = await createFixture();

  try {
    const result = await pullChannelVoice(fixture.creatorId, {
      prismaClient: prisma,
      channelUrl: "@MrBeast",
      clipServiceClient: fakeClipService({
        async transcribeRemote() {
          throw new ClipServiceApiError(
            502,
            "Clip service /transcribe-remote failed with 502: YouTube blocked this server request.",
            "yt_blocked",
          );
        },
      }),
      async distillTenets() {
        return tenets;
      },
      mindsClient: recordingMindsClient("Stored."),
    });

    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "yt_blocked");

    const creator = await prisma.creator.findUniqueOrThrow({
      where: {
        id: fixture.creatorId,
      },
      select: {
        channelPullStage: true,
        channelPullError: true,
      },
    });
    assert.equal(
      channelPullStatusResponse(
        creator.channelPullStage,
        creator.channelPullError,
      ).error,
      YT_BLOCKED_CHANNEL_PULL_MESSAGE,
    );
  } finally {
    await cleanupFixture(fixture.creatorId);
  }
});

type ChannelPullFixture = {
  creatorId: string;
  mindId: string;
  captionCorpus: string;
  firstVideoTranscript: string;
};

async function createFixture(
  options: { markerSuffix?: string } = {},
): Promise<ChannelPullFixture> {
  const marker = `channel-pull-${options.markerSuffix ?? "test"}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const captionCorpus = "bro the copper hoe actually saved me";
  const firstVideoTranscript = "The first upload has the creator voice.";
  const creator = await prisma.creator.create({
    data: {
      accessCode: `${marker}-code`,
      displayName: "Channel Pull Tester",
      channelUrl: "https://www.youtube.com/@OldHandle",
      mindId: `mind-${marker}`,
      mindStage: "ready",
      captionCorpus,
      captionStyle: {
        preset: "clean-bold",
      },
    },
    select: {
      id: true,
      mindId: true,
    },
  });
  const video = await prisma.video.create({
    data: {
      creatorId: creator.id,
      contentKey: `${marker}-video`,
      status: "clipped",
      pipelineStage: "done",
    },
    select: {
      id: true,
    },
  });
  await prisma.clip.create({
    data: {
      creatorId: creator.id,
      videoId: video.id,
      startMs: 0,
      endMs: 8_000,
      status: "accepted",
      transcript: firstVideoTranscript,
    },
  });

  return {
    creatorId: creator.id,
    mindId: creator.mindId ?? "",
    captionCorpus,
    firstVideoTranscript,
  };
}

async function cleanupFixture(creatorId: string): Promise<void> {
  await prisma.learningEvent.deleteMany({
    where: {
      creatorId,
    },
  });
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
  await prisma.creator.deleteMany({
    where: {
      id: creatorId,
    },
  });
}

function fakeClipService(
  overrides: Partial<ChannelPullClipServiceClient> = {},
): ChannelPullClipServiceClient {
  return {
    async listChannel() {
      return channelVideos;
    },
    async transcribeRemote(videoUrl) {
      return transcript(`transcript for ${videoUrl}`);
    },
    ...overrides,
  };
}

function transcript(text: string): Transcript {
  return {
    text,
    segments: [
      {
        start_ms: 0,
        end_ms: 2_000,
        text,
      },
    ],
    words: [],
  };
}

function recordingMindsClient(
  confirmation: string,
  options: { addTenetsError?: Error } = {},
) {
  const state = {
    addOptions: null as { alias?: string; action?: string } | null,
  };

  return Object.assign(state, {
    async createMind(name: string) {
      return {
        mindId: `created-${name}`,
        mindEmail: "created@hellominds.ai",
      };
    },
    async addTenets(
      _mindId: string,
      _tenets: InitialTenets,
      addOptions?: { alias?: string; action?: string },
    ) {
      if (options.addTenetsError) {
        throw options.addTenetsError;
      }
      state.addOptions = addOptions ?? null;
      return confirmation;
    },
    async verifyTenets() {
      throw new Error("channel pull tests should not verify Tenets.");
    },
    async sendMessageAndWaitForReply() {
      throw new Error("channel pull tests should use addTenets.");
    },
  } satisfies MindsClient);
}
