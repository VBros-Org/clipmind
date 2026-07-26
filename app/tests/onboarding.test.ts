import test from "node:test";
import assert from "node:assert/strict";

import {
  MINDS_CREATION_SKIPPED_MESSAGE,
  type MindsClient,
} from "../lib/minds";
import {
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
  const mindsClient = recordingMindsClient("mind_123");

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
  assert.deepEqual(repository.savedMindId, "mind_123");
  assert.deepEqual(repository.savedTenets, tenets);
  assert.deepEqual(mindsClient.addedTenets, tenets);
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
  assert.equal(repository.savedMindId, null);
  assert.deepEqual(repository.savedTenets, tenets);
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

function recordingMindsClient(mindId: string) {
  const state = {
    addedTenets: null as InitialTenets | null,
  };

  return Object.assign(state, {
    async createMind() {
      return { mindId };
    },
    async addTenets(_mindId: string, value: InitialTenets) {
      state.addedTenets = value;
    },
  } satisfies MindsClient);
}
