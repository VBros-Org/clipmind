import "./helpers/db-test-guard";

import test from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../lib/db";
import { runFirstVideoOnboardingPipeline } from "../lib/video-onboarding";
import type { InitialTenets } from "../lib/tenets";

const tenets: InitialTenets = {
  version: "voice-distill-v1",
  generatedAt: "2026-07-28T00:00:00.000Z",
  voiceProfile: {
    sentenceStructure: ["Fast setup, dry reaction."],
    phrasingHabits: ["Uses wait to frame the clip."],
    hookStyle: ["Starts inside the action."],
    vocabulary: ["wait", "clip"],
  },
  clipTasteProfile: {
    preferredMoments: ["Reversals after a calm setup."],
    pacing: ["Payoff inside ten seconds."],
    emotionalSignals: ["Surprise and raised volume."],
    clipPatterns: ["Setup, turn, reaction."],
  },
  guardrails: ["Keep the reaction plain."],
};

test("Mind onboarding failure leaves profile and uploaded corpus intact", async () => {
  const fixture = await createFixture();
  const calls: string[] = [];

  try {
    const result = await runFirstVideoOnboardingPipeline(fixture.videoId, {
      prismaClient: prisma,
      storage: {
        async presignSourceUrl(sourceKey) {
          calls.push(`presign:${sourceKey}`);
          return `https://signed.example/${sourceKey}`;
        },
      },
      async transcribeItem(item) {
        calls.push(`transcribe:${item.source}`);
        return {
          text: "Wait, that was the clip.",
          segments: [],
          words: [],
        };
      },
      async distillTenets() {
        calls.push("distill");
        return tenets;
      },
      mindsClient: {
        async createMind() {
          calls.push("createMind");
          return {
            mindId: "mind-failure-test",
            mindEmail: "mind-failure-test@hellominds.ai",
          };
        },
        async addTenets() {
          calls.push("addTenets");
          throw new Error("Tenet seed timed out waiting for a Mind reply.");
        },
        async verifyTenets() {
          throw new Error("verify should not run");
        },
        async sendMessageAndWaitForReply() {
          throw new Error("send should not run directly");
        },
      },
      async runPipelineImpl() {
        throw new Error("normal pipeline should wait for Mind onboarding");
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.failedStage, "teaching_taste");
    assert.deepEqual(calls, [
      `presign:${fixture.sourceKey}`,
      `transcribe:https://signed.example/${fixture.sourceKey}`,
      "distill",
      "createMind",
      "addTenets",
    ]);

    const creator = await prisma.creator.findUniqueOrThrow({
      where: {
        id: fixture.creatorId,
      },
      select: {
        displayName: true,
        accessCode: true,
        channelUrl: true,
        mindId: true,
        mindStage: true,
        mindError: true,
        initialTenets: true,
      },
    });
    assert.equal(creator.displayName, "Corpus Tester");
    assert.equal(creator.accessCode, fixture.accessCode);
    assert.equal(creator.channelUrl, "https://example.com/corpus");
    assert.equal(creator.mindId, "mind-failure-test");
    assert.equal(creator.mindStage, "failed");
    assert.match(creator.mindError ?? "", /^teaching_taste: /);
    assert.deepEqual(creator.initialTenets, tenets);

    const video = await prisma.video.findUniqueOrThrow({
      where: {
        id: fixture.videoId,
      },
      select: {
        creatorId: true,
        sourceKey: true,
        contentKey: true,
        pipelineStage: true,
        pipelineError: true,
      },
    });
    assert.equal(video.creatorId, fixture.creatorId);
    assert.equal(video.sourceKey, fixture.sourceKey);
    assert.equal(video.contentKey, fixture.contentKey);
    assert.equal(video.pipelineStage, "uploaded");
    assert.equal(video.pipelineError, null);
  } finally {
    await cleanupFixture(fixture.creatorId);
  }
});

test("learning_voice with malformed stored Tenets fails retryably instead of wedging", async () => {
  const fixture = await createFixture();

  try {
    await prisma.creator.update({
      where: {
        id: fixture.creatorId,
      },
      data: {
        mindStage: "learning_voice",
        initialTenets: {
          version: "bad-tenets",
        },
      },
    });

    const result = await runFirstVideoOnboardingPipeline(fixture.videoId, {
      prismaClient: prisma,
      storage: {
        async presignSourceUrl(sourceKey) {
          return `https://signed.example/${sourceKey}`;
        },
      },
      async transcribeItem() {
        throw new Error("transcriber unavailable after restart");
      },
      async distillTenets() {
        throw new Error("distill should wait for transcript");
      },
      mindsClient: null,
      async runPipelineImpl() {
        throw new Error("normal pipeline should not run after failed learning");
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.failedStage, "learning_voice");
    assert.match(result.error, /^learning_voice: transcriber unavailable/);

    const creator = await prisma.creator.findUniqueOrThrow({
      where: {
        id: fixture.creatorId,
      },
      select: {
        mindStage: true,
        mindError: true,
        mindStageAttempts: true,
      },
    });
    assert.equal(creator.mindStage, "failed");
    assert.match(creator.mindError ?? "", /^learning_voice: /);
    assert.deepEqual(creator.mindStageAttempts, {
      learning_voice: 1,
    });
  } finally {
    await cleanupFixture(fixture.creatorId);
  }
});

async function createFixture() {
  const marker = `video-onboarding-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const accessCode = `${marker}-code`;
  const creator = await prisma.creator.create({
    data: {
      accessCode,
      displayName: "Corpus Tester",
      channelUrl: "https://example.com/corpus",
      captionStyle: {
        preset: "clean-bold",
      },
      mindStage: "pending",
    },
  });
  const sourceKey = `videos/${marker}/source.mp4`;
  const contentKey = `uploaded:${creator.id}:${marker}`;
  const video = await prisma.video.create({
    data: {
      creatorId: creator.id,
      sourceKey,
      contentKey,
      status: "uploaded",
      pipelineStage: "uploaded",
    },
  });

  return {
    creatorId: creator.id,
    accessCode,
    videoId: video.id,
    sourceKey,
    contentKey,
  };
}

async function cleanupFixture(creatorId: string): Promise<void> {
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
