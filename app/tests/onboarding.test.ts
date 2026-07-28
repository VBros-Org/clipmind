import test from "node:test";
import assert from "node:assert/strict";

import {
  MINDS_CREATION_SKIPPED_MESSAGE,
  type MindsClient,
} from "../lib/minds";
import {
  DEFAULT_CREATOR_STEWARD_EMAIL,
  onboardCreator,
  type OnboardingRepository,
} from "../lib/onboarding";
import type { InitialTenets } from "../lib/tenets";

const tenets: InitialTenets = {
  version: "voice-distill-v1",
  generatedAt: "2026-07-26T00:00:00.000Z",
  voiceProfile: {
    sentenceStructure: ["Short setup, then a quick punchline."],
    phrasingHabits: ["Uses wait and watch to focus attention."],
    hookStyle: ["Opens with an immediate reaction."],
    vocabulary: ["wait", "moment"],
  },
  clipTasteProfile: {
    preferredMoments: ["Sudden reversals after a quiet setup."],
    pacing: ["Fast setup with payoff inside ten seconds."],
    emotionalSignals: ["Surprised laughter and rising volume."],
    clipPatterns: ["Setup, mistake, reaction."],
  },
  guardrails: ["Keep the dry reaction style."],
};

test("onboarding persists mindId and initial Tenets when Minds client succeeds", async () => {
  const repository = recordingRepository("creator_1");
  const mindsClient = recordingMindsClient(
    "mind_123",
    "mind_123@hellominds.ai",
    "I remember the dry reaction style.",
  );

  const result = await onboardCreator({
    creatorId: "creator_1",
    corpusItems: [
      {
        source: "clip.mp4",
        sourceType: "existing_clip",
        weight: 3,
      },
    ],
    repository,
    transcribeItem: async () => ({
      text: "Wait, this is the moment.",
      segments: [],
      words: [],
    }),
    distillTenets: async () => tenets,
    mindsClient,
  });

  assert.equal(result.status, "PASSED");
  assert.equal(result.mindId, "mind_123");
  assert.equal(result.mindEmail, "mind_123@hellominds.ai");
  assert.equal(result.verifyTenetsReply, "I remember the dry reaction style.");
  assert.deepEqual(repository.savedMindId, "mind_123");
  assert.deepEqual(repository.savedTenets, tenets);
  assert.deepEqual(mindsClient.createdMind, {
    name: "ClipMind creator1",
    stewardEmail: DEFAULT_CREATOR_STEWARD_EMAIL,
  });
  assert.deepEqual(mindsClient.addedTenets, tenets);
  assert.equal(mindsClient.verifiedMindId, "mind_123");
});

test("onboarding defers Mind creation when the Minds client is absent", async () => {
  const repository = recordingRepository("creator_2");

  const result = await onboardCreator({
    creatorId: "creator_2",
    corpusItems: [
      {
        source: "source.mp4",
        sourceType: "source_video",
        weight: 1,
      },
    ],
    repository,
    transcribeItem: async () => ({
      text: "This is a source video.",
      segments: [],
      words: [],
    }),
    distillTenets: async () => tenets,
    mindsClient: null,
  });

  assert.equal(result.status, "DEFERRED");
  assert.equal(result.message, MINDS_CREATION_SKIPPED_MESSAGE);
  assert.equal(result.mindEmail, null);
  assert.equal(result.verifyTenetsReply, null);
  assert.equal(repository.savedMindId, null);
  assert.deepEqual(repository.savedTenets, tenets);
});

test("onboarding passes an explicit steward email to Minds creation", async () => {
  const repository = recordingRepository("creator_3");
  const mindsClient = recordingMindsClient(
    "mind_456",
    "mind_456@hellominds.ai",
    "I remember the fast payoff style.",
  );

  await onboardCreator({
    creatorId: "creator_3",
    stewardEmail: "creator@example.com",
    corpusItems: [
      {
        source: "source.mp4",
        sourceType: "source_video",
        weight: 1,
      },
    ],
    repository,
    transcribeItem: async () => ({
      text: "This is a source video.",
      segments: [],
      words: [],
    }),
    distillTenets: async () => tenets,
    mindsClient,
  });

  assert.deepEqual(mindsClient.createdMind, {
    name: "ClipMind creator3",
    stewardEmail: "creator@example.com",
  });
});

function recordingRepository(creatorId: string) {
  const state = {
    savedMindId: null as string | null,
    savedTenets: null as InitialTenets | null,
  };

  return Object.assign(state, {
    async ensureCreator() {
      return { id: creatorId };
    },
    async saveInitialTenets(_creatorId: string, value: InitialTenets) {
      state.savedTenets = value;
    },
    async saveMindId(_creatorId: string, mindId: string) {
      state.savedMindId = mindId;
    },
    async saveMindIdAndInitialTenets(
      _creatorId: string,
      mindId: string,
      value: InitialTenets,
    ) {
      state.savedMindId = mindId;
      state.savedTenets = value;
    },
  } satisfies OnboardingRepository);
}

function recordingMindsClient(
  mindId: string,
  mindEmail: string,
  verifyTenetsReply: string,
) {
  const state = {
    createdMind: null as { name: string; stewardEmail: string } | null,
    addedTenets: null as InitialTenets | null,
    verifiedMindId: null as string | null,
  };

  return Object.assign(state, {
    async createMind(name: string, stewardEmail: string) {
      state.createdMind = { name, stewardEmail };
      return { mindId, mindEmail };
    },
    async addTenets(_mindId: string, value: InitialTenets) {
      state.addedTenets = value;
    },
    async verifyTenets(value: string) {
      state.verifiedMindId = value;
      return verifyTenetsReply;
    },
    async sendMessageAndWaitForReply() {
      throw new Error("onboarding tests should use addTenets and verifyTenets.");
    },
  } satisfies MindsClient);
}
