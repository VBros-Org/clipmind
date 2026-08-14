import test from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../lib/db";
import type { MindsClient } from "../lib/minds";
import type { InitialTenets } from "../lib/tenets";
import {
  buildVoiceReseedAlias,
  handleTeachVoice,
  saveCaptionCorpusForCreator,
  teachCreatorVoiceFromCaptionCorpus,
} from "../lib/voice-corpus";
import { cookieHeaderForAccessCode } from "../lib/review-auth";
import {
  MAX_CAPTION_CORPUS_CHARS,
  MAX_CAPTION_CORPUS_LINES,
  normalizeCaptionCorpus,
} from "../lib/caption-corpus";

const tenets: InitialTenets = {
  version: "voice-distill-v1",
  generatedAt: "2026-07-29T00:00:00.000Z",
  voiceProfile: {
    sentenceStructure: ["Short lowercase reaction captions."],
    phrasingHabits: ["Uses bro as a casual tag."],
    hookStyle: ["Starts inside the mistake."],
    vocabulary: ["bro", "rip"],
  },
  clipTasteProfile: {
    preferredMoments: ["Last second saves."],
    pacing: ["Fast payoff."],
    emotionalSignals: ["Sudden relief."],
    clipPatterns: ["Problem, save, reaction."],
  },
  guardrails: ["Keep captions plain."],
};

test("caption corpus normalization caps to 20 lines and 4000 chars", () => {
  const longLines = Array.from(
    { length: MAX_CAPTION_CORPUS_LINES + 5 },
    (_value, index) => `caption ${index + 1}`,
  ).join("\n");
  const normalized = normalizeCaptionCorpus(longLines);

  assert.equal(normalized.captionCount, MAX_CAPTION_CORPUS_LINES);
  assert.equal(normalized.captionCorpus?.split("\n").length, 20);

  const longCaption = "x".repeat(MAX_CAPTION_CORPUS_CHARS + 200);
  const capped = normalizeCaptionCorpus(longCaption);
  assert.equal(capped.captionCorpus?.length, MAX_CAPTION_CORPUS_CHARS);
});

test("saveCaptionCorpusForCreator stores normalized corpus", async () => {
  const fixture = await createFixture();

  try {
    const result = await saveCaptionCorpusForCreator(
      fixture.creatorId,
      " first caption \n\n second caption ",
      {
        prismaClient: prisma,
      },
    );

    assert.equal(result.captionCorpus, "first caption\nsecond caption");
    assert.equal(result.captionCount, 2);

    const creator = await prisma.creator.findUniqueOrThrow({
      where: {
        id: fixture.creatorId,
      },
      select: {
        captionCorpus: true,
      },
    });
    assert.equal(creator.captionCorpus, "first caption\nsecond caption");
  } finally {
    await cleanupFixture(fixture.creatorId);
  }
});

test("corpus-only creator can teach and wake a Mind", async () => {
  const fixture = await createCorpusOnlyFixture();
  const mindsClient = recordingMindsClient("Stored corpus-only voice.", {
    mindId: "mind-corpus-only",
  });
  const now = new Date("2026-08-14T10:00:00.000Z");
  const captionCorpus = [
    "bro this save came out of nowhere",
    "zero seconds left and somehow we lived",
  ].join("\n");

  try {
    const response = await handleTeachVoice(
      new Request("http://localhost/api/voice/corpus", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeaderForAccessCode(fixture.accessCode),
        },
        body: JSON.stringify({
          captionCorpus,
        }),
      }),
      {
        prismaClient: prisma,
        mindsClient,
        now,
        async distillTenets(transcripts, evidence) {
          assert.equal(transcripts.length, 0);
          assert.equal(evidence?.captionCorpus, captionCorpus);
          return tenets;
        },
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      creatorId: fixture.creatorId,
      captionCorpus,
      captionCount: 2,
      mindId: "mind-corpus-only",
      confirmation: "Stored corpus-only voice.",
    });
    assert.deepEqual(mindsClient.createdMindIds, ["mind-corpus-only"]);
    assert.deepEqual(mindsClient.seededMindIds, ["mind-corpus-only"]);

    const creator = await prisma.creator.findUniqueOrThrow({
      where: {
        id: fixture.creatorId,
      },
      select: {
        captionCorpus: true,
        initialTenets: true,
        mindId: true,
        mindStage: true,
        mindError: true,
      },
    });
    assert.equal(creator.captionCorpus, captionCorpus);
    assert.deepEqual(creator.initialTenets, tenets);
    assert.equal(creator.mindId, "mind-corpus-only");
    assert.equal(creator.mindStage, "ready");
    assert.equal(creator.mindError, null);
  } finally {
    await cleanupFixture(fixture.creatorId);
  }
});

test("orphan Mind is disabled when the atomic Mind claim loses", async () => {
  const fixture = await createCorpusOnlyFixture();
  const mindsClient = recordingMindsClient("Stored winner voice.", {
    async createMindImpl() {
      await prisma.creator.update({
        where: {
          id: fixture.creatorId,
        },
        data: {
          mindId: "mind-winning-claim",
          mindStage: "ready",
        },
      });
      return {
        mindId: "mind-orphaned-claim",
        mindEmail: "mind-orphaned-claim@hellominds.ai",
      };
    },
  });

  try {
    const result = await teachCreatorVoiceFromCaptionCorpus(
      fixture.creatorId,
      "winner claim caption",
      {
        prismaClient: prisma,
        mindsClient,
        async distillTenets() {
          return tenets;
        },
      },
    );

    assert.equal(result.mindId, "mind-winning-claim");
    assert.deepEqual(mindsClient.seededMindIds, ["mind-winning-claim"]);
    assert.deepEqual(mindsClient.disabledMindIds, ["mind-orphaned-claim"]);

    const creator = await prisma.creator.findUniqueOrThrow({
      where: {
        id: fixture.creatorId,
      },
      select: {
        mindId: true,
        mindStage: true,
      },
    });
    assert.equal(creator.mindId, "mind-winning-claim");
    assert.equal(creator.mindStage, "ready");
  } finally {
    await cleanupFixture(fixture.creatorId);
  }
});

test("teachCreatorVoiceFromCaptionCorpus distills with captions and re-seeds the Mind", async () => {
  const fixture = await createFixture();
  const mindsClient = recordingMindsClient("Stored copper hoe caption voice.");
  const now = new Date("2026-07-29T14:30:00.000Z");
  const captionCorpus = [
    "bro the copper hoe actually saved me",
    "arcs be killing bro, rip",
    "have you ever seen a run saved at zero seconds",
  ].join("\n");

  try {
    const result = await teachCreatorVoiceFromCaptionCorpus(
      fixture.creatorId,
      captionCorpus,
      {
        prismaClient: prisma,
        mindsClient,
        now,
        async distillTenets(transcripts, evidence) {
          assert.equal(transcripts.length, 1);
          assert.equal(transcripts[0]?.sourceType, "existing_clip");
          assert.equal(evidence?.captionCorpus, captionCorpus);
          return tenets;
        },
      },
    );

    assert.equal(result.confirmation, "Stored copper hoe caption voice.");
    assert.equal(result.captionCount, 3);
    assert.equal(result.mindId, fixture.mindId);
    assert.deepEqual(mindsClient.addedTenets, tenets);
    assert.deepEqual(mindsClient.addOptions, {
      alias: buildVoiceReseedAlias(fixture.creatorId, now),
      action: "Voice corpus Tenet seed",
    });

    const creator = await prisma.creator.findUniqueOrThrow({
      where: {
        id: fixture.creatorId,
      },
      select: {
        captionCorpus: true,
        initialTenets: true,
      },
    });
    assert.equal(creator.captionCorpus, captionCorpus);
    assert.deepEqual(creator.initialTenets, tenets);
  } finally {
    await cleanupFixture(fixture.creatorId);
  }
});

async function createFixture(): Promise<{
  creatorId: string;
  mindId: string;
}> {
  const marker = `voice-corpus-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const mindId = `mind-${marker}`;
  const creator = await prisma.creator.create({
    data: {
      accessCode: `${marker}-code`,
      mindId,
      mindStage: "ready",
      captionStyle: {
        preset: "clean-bold",
      },
    },
    select: {
      id: true,
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
      transcript: "The spoken clip has a last second save.",
    },
  });

  return {
    creatorId: creator.id,
    mindId,
  };
}

async function createCorpusOnlyFixture(): Promise<{
  creatorId: string;
  accessCode: string;
}> {
  const marker = `voice-corpus-only-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const creator = await prisma.creator.create({
    data: {
      accessCode: `${marker}-code`,
      mindId: null,
      mindStage: "pending",
      captionStyle: {
        preset: "clean-bold",
      },
    },
    select: {
      id: true,
      accessCode: true,
    },
  });

  return {
    creatorId: creator.id,
    accessCode: creator.accessCode ?? "",
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

function recordingMindsClient(
  confirmation: string,
  options: {
    mindId?: string;
    createMindImpl?: () => Promise<{ mindId: string; mindEmail: string }>;
  } = {},
) {
  const state = {
    addedTenets: null as InitialTenets | null,
    addOptions: null as { alias?: string; action?: string } | null,
    createdMindIds: [] as string[],
    seededMindIds: [] as string[],
    disabledMindIds: [] as string[],
  };

  return Object.assign(state, {
    async createMind() {
      const mind = options.createMindImpl
        ? await options.createMindImpl()
        : {
            mindId: options.mindId ?? "created-voice-corpus-mind",
            mindEmail: "created-voice-corpus-mind@hellominds.ai",
          };
      state.createdMindIds.push(mind.mindId);
      return mind;
    },
    async disableMind(mindId: string) {
      state.disabledMindIds.push(mindId);
    },
    async addTenets(
      _mindId: string,
      value: InitialTenets,
      options?: { alias?: string; action?: string },
    ) {
      state.addedTenets = value;
      state.addOptions = options ?? null;
      state.seededMindIds.push(_mindId);
      return confirmation;
    },
    async verifyTenets() {
      throw new Error("voice corpus tests should not verify Tenets.");
    },
    async sendMessageAndWaitForReply() {
      throw new Error("voice corpus tests should use addTenets.");
    },
  } satisfies MindsClient);
}
