import test from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../lib/db";
import { ClipServiceApiError, type ChannelVideo } from "../lib/clip-service";
import {
  CHANNEL_PULL_MAX_VIDEO_DURATION_S,
  ChannelPullInputError,
  buildChannelPullReseedAlias,
  channelPullStatusResponse,
  handleStartChannelPull,
  normalizeYouTubeChannelInput,
  pullChannelVoice,
  selectChannelVideosForVoice,
  type ChannelPullClipServiceClient,
  type ChannelPullOptions,
} from "../lib/channelPull";
import { YT_BLOCKED_CHANNEL_PULL_MESSAGE } from "../lib/channel-pull-status";
import { cookieHeaderForAccessCode } from "../lib/review-auth";
import { runFirstVideoOnboardingPipeline } from "../lib/video-onboarding";
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
        channelPullRunId: true,
        channelPullLeaseHeartbeatAt: true,
        channelPullStageAttempts: true,
        initialTenets: true,
      },
    });
    assert.equal(creator.channelUrl, "https://www.youtube.com/@MrBeast");
    assert.equal(creator.channelPullStage, "done");
    assert.equal(creator.channelPullError, null);
    assert.ok(creator.channelPullRunId?.startsWith("channel-pull-"));
    assert.ok(creator.channelPullLeaseHeartbeatAt);
    assert.deepEqual(creator.channelPullStageAttempts, {
      listing: 1,
      transcribing_1: 1,
      transcribing_2: 1,
      transcribing_3: 1,
      distilling: 1,
      seeding: 1,
    });
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

test("channel pull POST restarts an expired active lease", async () => {
  const fixture = await createFixture();
  const pullCalls: Array<{ creatorId: string; channelUrl: string | undefined }> = [];

  try {
    await prisma.creator.update({
      where: {
        id: fixture.creatorId,
      },
      data: {
        channelPullStage: "transcribing_2",
        channelPullError: null,
        channelPullRunId: "channel-pull-dead-run",
        channelPullLeaseHeartbeatAt: new Date("2026-08-14T09:00:00.000Z"),
      },
    });

    const response = await handleStartChannelPull(
      new Request("https://clipmind.test/api/voice/channel-pull", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeaderForAccessCode(fixture.accessCode),
        },
        body: JSON.stringify({
          channelUrl: "@MrBeast",
        }),
      }),
      {
        prismaClient: prisma,
        now: new Date("2026-08-14T09:11:00.000Z"),
        async pullChannelVoiceImpl(creatorId, options) {
          pullCalls.push({
            creatorId,
            channelUrl: options.channelUrl,
          });
          return {
            status: "done",
            creatorId,
            channelUrl: options.channelUrl ?? "",
            mindId: fixture.mindId,
            mindEmail: null,
            listedCount: 0,
            transcriptCount: 0,
            selectedVideos: [],
            confirmation: "started",
          };
        },
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      channelUrl: "https://www.youtube.com/@MrBeast",
      stage: "listing",
      error: null,
      errorCode: null,
    });
    assert.deepEqual(pullCalls, [
      {
        creatorId: fixture.creatorId,
        channelUrl: "https://www.youtube.com/@MrBeast",
      },
    ]);

    const creator = await prisma.creator.findUniqueOrThrow({
      where: {
        id: fixture.creatorId,
      },
      select: {
        channelPullStage: true,
        channelPullRunId: true,
        channelPullLeaseHeartbeatAt: true,
      },
    });
    assert.equal(creator.channelPullStage, "listing");
    assert.notEqual(creator.channelPullRunId, "channel-pull-dead-run");
    assert.deepEqual(
      channelPullStatusResponse(creator.channelPullStage, null, {
        leaseHeartbeatAt: creator.channelPullLeaseHeartbeatAt,
        now: new Date("2026-08-14T09:11:00.000Z"),
      }),
      {
        stage: "listing",
        error: null,
        errorCode: null,
      },
    );
  } finally {
    await cleanupFixture(fixture.creatorId);
  }
});

test("channel pull status reports expired active leases as failed", () => {
  assert.deepEqual(
    channelPullStatusResponse("transcribing_2", null, {
      leaseHeartbeatAt: new Date("2026-08-14T09:00:00.000Z"),
      now: new Date("2026-08-14T09:11:00.000Z"),
    }),
    {
      stage: "failed",
      error: "Recent video pull failed. Paste captions or upload a video instead.",
      errorCode: null,
    },
  );
});

test("parallel channel pull and first-video onboarding create one Mind and share it", async () => {
  const fixture = await createMindlessFixture();
  const mindsClient = recordingMindsClient("Stored shared creator voice.");
  const pipelineCalls: string[] = [];
  let releaseCreateMind: () => void = () => undefined;
  const createMindCanFinish = new Promise<void>((resolve) => {
    releaseCreateMind = resolve;
  });
  mindsClient.createMindImpl = async () => {
    mindsClient.createdMindIds.push("created-shared-mind");
    await createMindCanFinish;
    return {
      mindId: "created-shared-mind",
      mindEmail: "created-shared-mind@hellominds.ai",
    };
  };

  try {
    const uploadRun = runFirstVideoOnboardingPipeline(fixture.videoId, {
      prismaClient: prisma,
      storage: {
        async presignSourceUrl(sourceKey) {
          return `https://signed.example/${sourceKey}`;
        },
      },
      async transcribeItem() {
        return transcript("First upload teaches the creator voice.");
      },
      async distillTenets() {
        return tenets;
      },
      mindsClient,
      adoptionPollMs: 5,
      async runPipelineImpl(videoId) {
        pipelineCalls.push(videoId);
        return {
          status: "done",
          videoId,
          creatorId: fixture.creatorId,
          clipCount: 0,
          captionedClipIds: [],
        };
      },
    });
    const channelRun = pullChannelVoice(fixture.creatorId, {
      prismaClient: prisma,
      channelUrl: "@MrBeast",
      clipServiceClient: fakeClipService(),
      async distillTenets() {
        return tenets;
      },
      mindsClient,
      adoptionPollMs: 5,
      onStageChange(stage) {
        if (stage === "seeding") {
          releaseCreateMind();
        }
      },
    });

    const [uploadResult, channelResult] = await Promise.all([
      uploadRun,
      channelRun,
    ]);

    assert.equal(uploadResult.status, "done");
    assert.equal(channelResult.status, "done");
    assert.equal(channelResult.mindId, "created-shared-mind");
    assert.deepEqual(mindsClient.createdMindIds, ["created-shared-mind"]);
    assert.deepEqual(
      [...new Set(mindsClient.seededMindIds)],
      ["created-shared-mind"],
    );
    assert.deepEqual(pipelineCalls, [fixture.videoId]);

    const creator = await prisma.creator.findUniqueOrThrow({
      where: {
        id: fixture.creatorId,
      },
      select: {
        mindId: true,
        mindStage: true,
      },
    });
    assert.equal(creator.mindId, "created-shared-mind");
    assert.equal(creator.mindStage, "ready");
  } finally {
    releaseCreateMind();
    await cleanupFixture(fixture.creatorId);
  }
});

test("channel pull persists partial transcripts and retry skips finished videos", async () => {
  const fixture = await createFixture({
    markerSuffix: "partial-retry",
  });
  const firstRunTranscribes: string[] = [];
  const retryTranscribes: string[] = [];

  try {
    const firstResult = await pullChannelVoice(fixture.creatorId, {
      prismaClient: prisma,
      channelUrl: "@MrBeast",
      clipServiceClient: fakeClipService({
        async transcribeRemote(videoUrl) {
          const videoId = new URL(videoUrl).searchParams.get("v") ?? "";
          firstRunTranscribes.push(videoId);
          if (videoId === "video-3") {
            throw new Error("third transcript failed");
          }

          return transcript(`stored transcript for ${videoId}`);
        },
      }),
      async distillTenets() {
        throw new Error("first run should fail before distilling");
      },
      mindsClient: recordingMindsClient("unused"),
    });

    assert.equal(firstResult.status, "failed");
    assert.equal(firstResult.failedStage, "transcribing_3");
    assert.deepEqual(firstRunTranscribes, ["video-1", "video-2", "video-3"]);

    const storedAfterFailure = await prisma.channelPullTranscript.findMany({
      where: {
        creatorId: fixture.creatorId,
      },
      orderBy: {
        videoId: "asc",
      },
      select: {
        videoId: true,
      },
    });
    assert.deepEqual(
      storedAfterFailure.map((item) => item.videoId),
      ["video-1", "video-2"],
    );

    const retryResult = await pullChannelVoice(fixture.creatorId, {
      prismaClient: prisma,
      channelUrl: "@MrBeast",
      clipServiceClient: fakeClipService({
        async transcribeRemote(videoUrl) {
          const videoId = new URL(videoUrl).searchParams.get("v") ?? "";
          retryTranscribes.push(videoId);
          return transcript(`retry transcript for ${videoId}`);
        },
      }),
      async distillTenets(transcripts) {
        assert.deepEqual(new Set(transcripts.map((item) => item.source)), new Set([
          `clip:${fixture.clipId}`,
          "youtube:video-1",
          "youtube:video-2",
          "youtube:video-3",
        ]));
        const transcriptBySource = new Map(
          transcripts.map((item) => [item.source, item.transcript.text]),
        );
        assert.equal(
          transcriptBySource.get("youtube:video-1"),
          "stored transcript for video-1",
        );
        assert.equal(
          transcriptBySource.get("youtube:video-2"),
          "stored transcript for video-2",
        );
        assert.equal(
          transcriptBySource.get("youtube:video-3"),
          "retry transcript for video-3",
        );
        return tenets;
      },
      mindsClient: recordingMindsClient("Stored."),
    });

    assert.equal(retryResult.status, "done");
    assert.equal(retryResult.transcriptCount, 3);
    assert.deepEqual(retryTranscribes, ["video-3"]);
  } finally {
    await cleanupFixture(fixture.creatorId);
  }
});

type ChannelPullFixture = {
  creatorId: string;
  mindId: string;
  accessCode: string;
  captionCorpus: string;
  firstVideoTranscript: string;
  clipId: string;
  videoId: string;
  sourceKey: string;
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
      accessCode: true,
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
  const clip = await prisma.clip.create({
    select: {
      id: true,
    },
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
    accessCode: creator.accessCode ?? "",
    captionCorpus,
    firstVideoTranscript,
    clipId: clip.id,
    videoId: video.id,
    sourceKey: `videos/${marker}/source.mp4`,
  };
}

async function createMindlessFixture(): Promise<ChannelPullFixture> {
  const fixture = await createFixture({
    markerSuffix: "parallel",
  });
  const sourceKey = `videos/${fixture.creatorId}/first-source.mp4`;
  await prisma.creator.update({
    where: {
      id: fixture.creatorId,
    },
    data: {
      mindId: null,
      mindStage: "pending",
      mindRunId: null,
      mindLeaseHeartbeatAt: null,
      mindError: null,
    },
  });
  const video = await prisma.video.create({
    data: {
      creatorId: fixture.creatorId,
      sourceKey,
      contentKey: `${fixture.creatorId}-first-video`,
      status: "uploaded",
      pipelineStage: "uploaded",
    },
    select: {
      id: true,
    },
  });

  return {
    ...fixture,
    mindId: "",
    videoId: video.id,
    sourceKey,
  };
}

async function cleanupFixture(creatorId: string): Promise<void> {
  await prisma.channelPullTranscript.deleteMany({
    where: {
      creatorId,
    },
  });
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
    createdMindIds: [] as string[],
    seededMindIds: [] as string[],
    createMindImpl: null as
      | null
      | ((name: string) => Promise<{ mindId: string; mindEmail: string }>),
  };

  return Object.assign(state, {
    async createMind(name: string) {
      if (state.createMindImpl) {
        return state.createMindImpl(name);
      }
      const mindId = `created-${name}`;
      state.createdMindIds.push(mindId);
      return {
        mindId,
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
      state.seededMindIds.push(_mindId);
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
