import test from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../lib/db";
import type { MindsClient } from "../lib/minds";
import type { InitialTenets } from "../lib/tenets";
import {
  buildVoiceReseedAlias,
  saveCaptionCorpusForCreator,
  teachCreatorVoiceFromCaptionCorpus,
} from "../lib/voice-corpus";
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

function recordingMindsClient(confirmation: string) {
  const state = {
    addedTenets: null as InitialTenets | null,
    addOptions: null as { alias?: string; action?: string } | null,
  };

  return Object.assign(state, {
    async createMind() {
      throw new Error("voice corpus tests should not create Minds.");
    },
    async addTenets(
      _mindId: string,
      value: InitialTenets,
      options?: { alias?: string; action?: string },
    ) {
      state.addedTenets = value;
      state.addOptions = options ?? null;
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
