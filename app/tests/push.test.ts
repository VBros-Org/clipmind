import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { Prisma } from "@prisma/client";

import { prisma } from "../lib/db";
import { computeDueNudges, type DueNudge } from "../lib/nudges";
import { handlePushTick } from "../lib/push-api";
import {
  resetFcmAccessTokenCacheForTests,
  sendPushNudgeToCreator,
} from "../lib/push";
import { runPushTick } from "../lib/push-tick";
import { runPushTickWithAdvisoryLock } from "../lib/push-tick-interval";

type PushFixture = {
  creatorId: string;
  videoId: string;
  clipId: string;
};

const DEFAULT_POST_SLOT = new Date("2026-07-29T09:00:00.000Z");

test("push tick rejects a bad CRON_SECRET", async () => {
  const response = await handlePushTick(
    new Request("http://localhost/api/push/tick", {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong",
      },
    }),
    {
      env: {
        CRON_SECRET: "right",
      },
      runPushTickImpl: async () => {
        throw new Error("Unauthorized ticks should not run.");
      },
    },
  );

  assert.equal(response.status, 401);
});

test("push tick dedupes the same nudge key", async () => {
  const fixture = await createPushFixture("dedupe");
  const disabledCreatorIds = await disableOtherPushSchedules([fixture.creatorId]);
  const disabledSubscriptionIds = await disableOtherPushSubscriptions([
    fixture.creatorId,
  ]);
  const now = new Date("2026-07-29T09:05:00.000Z");
  let sendCalls = 0;

  try {
    const first = await runPushTick(now, {
      prismaClient: prisma,
      sendPushNudgeToCreatorImpl: async (creatorId, nudge) => {
        sendCalls += 1;
        assert.equal(creatorId, fixture.creatorId);
        assert.equal(nudge.kind, "post");
        return {
          creatorId,
          attempted: 1,
          sent: 1,
          disabled: 0,
          failures: [],
          messageIds: ["projects/test/messages/one"],
        };
      },
    });
    assert.equal(first.sent, 1);
    assert.equal(first.skippedDuplicate, 0);

    const second = await runPushTick(now, {
      prismaClient: prisma,
      sendPushNudgeToCreatorImpl: async () => {
        throw new Error("Duplicate tick should not send.");
      },
    });
    assert.equal(second.sent, 0);
    assert.equal(second.skippedDuplicate, 1);
    assert.equal(sendCalls, 1);

    const logCount = await prisma.nudgeLog.count({
      where: {
        creatorId: fixture.creatorId,
        kind: "post",
        dedupeKey: postDedupeKey(fixture.clipId, DEFAULT_POST_SLOT),
        status: "sent",
      },
    });
    assert.equal(logCount, 1);
  } finally {
    await restorePushSubscriptions(disabledSubscriptionIds);
    await restorePushSchedules(disabledCreatorIds);
    await cleanupPushFixture(fixture);
  }
});

test("push tick sends failed upload nudges once when push reminders are off", async () => {
  const fixture = await createFailedPushFixture("failed-always-on");
  const disabledCreatorIds = await disableOtherPushSchedules([fixture.creatorId]);
  const disabledSubscriptionIds = await disableOtherPushSubscriptions([
    fixture.creatorId,
  ]);
  const now = new Date("2026-07-29T09:15:00.000Z");
  let sendCalls = 0;

  try {
    const first = await runPushTick(now, {
      prismaClient: prisma,
      sendPushNudgeToCreatorImpl: async (creatorId, nudge) => {
        sendCalls += 1;
        assert.equal(creatorId, fixture.creatorId);
        assert.equal(nudge.kind, "failed");
        assert.equal(nudge.dedupeKey, `${fixture.videoId}:0`);
        assert.equal(
          nudge.title,
          "Upload failed at captions. Tap to retry.",
        );
        return {
          creatorId,
          attempted: 1,
          sent: 1,
          disabled: 0,
          failures: [],
          messageIds: ["projects/test/messages/failed"],
        };
      },
    });
    assert.equal(first.sent, 1);
    assert.equal(first.skippedDuplicate, 0);

    const second = await runPushTick(now, {
      prismaClient: prisma,
      sendPushNudgeToCreatorImpl: async () => {
        throw new Error("Duplicate failure should not send.");
      },
    });
    assert.equal(second.sent, 0);
    assert.equal(second.skippedDuplicate, 1);
    assert.equal(sendCalls, 1);

    const logCount = await prisma.nudgeLog.count({
      where: {
        creatorId: fixture.creatorId,
        kind: "failed",
        dedupeKey: `${fixture.videoId}:0`,
        status: "sent",
      },
    });
    assert.equal(logCount, 1);
  } finally {
    await restorePushSubscriptions(disabledSubscriptionIds);
    await restorePushSchedules(disabledCreatorIds);
    await cleanupPushFixture(fixture);
  }
});

test("push tick does not nudge scheduled clips until render and captions are ready", async () => {
  const unrendered = await createPushFixture("unrendered", {
    renderedUrl: null,
  });
  const captionless = await createPushFixture("captionless", {
    postCopyVariants: null,
  });
  const disabledCreatorIds = await disableOtherPushSchedules([
    unrendered.creatorId,
    captionless.creatorId,
  ]);
  const disabledSubscriptionIds = await disableOtherPushSubscriptions([
    unrendered.creatorId,
    captionless.creatorId,
  ]);
  const now = new Date("2026-07-29T09:05:00.000Z");

  try {
    const result = await runPushTick(now, {
      prismaClient: prisma,
      sendPushNudgeToCreatorImpl: async () => {
        throw new Error("Unready scheduled clips should not send post nudges.");
      },
    });

    assert.equal(result.nudgesDue, 0);
    assert.equal(result.sent, 0);

    const postLogs = await prisma.nudgeLog.count({
      where: {
        creatorId: {
          in: [unrendered.creatorId, captionless.creatorId],
        },
        kind: "post",
      },
    });
    assert.equal(postLogs, 0);
  } finally {
    await restorePushSubscriptions(disabledSubscriptionIds);
    await restorePushSchedules(disabledCreatorIds);
    await cleanupPushFixture(captionless);
    await cleanupPushFixture(unrendered);
  }
});

test("guarded push ticks reject overlaps and release the lock after the tick", async () => {
  const fixture = await createPushFixture("guard-overlap");
  const disabledCreatorIds = await disableOtherPushSchedules([fixture.creatorId]);
  const disabledSubscriptionIds = await disableOtherPushSubscriptions([
    fixture.creatorId,
  ]);
  const now = new Date("2026-07-29T09:05:00.000Z");
  let sendCalls = 0;
  let releaseSend: () => void = () => {};
  const sendStarted = deferred<void>();
  const sendRelease = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });

  try {
    const firstTick = runPushTickWithAdvisoryLock(now, {
      prismaClient: prisma,
      sendPushNudgeToCreatorImpl: async (creatorId) => {
        sendCalls += 1;
        assert.equal(creatorId, fixture.creatorId);
        sendStarted.resolve();
        await sendRelease;
        return sentPushResult(creatorId, "projects/test/messages/guarded");
      },
    });

    await sendStarted.promise;

    const overlapped = await runPushTickWithAdvisoryLock(now, {
      prismaClient: prisma,
      sendPushNudgeToCreatorImpl: async () => {
        throw new Error("Locked tick should not send.");
      },
    });
    assert.equal(overlapped.status, "locked");

    releaseSend();
    const first = await firstTick;
    assert.equal(first.status, "done");
    assert.equal(first.sent, 1);
    assert.equal(sendCalls, 1);

    const after = await runPushTickWithAdvisoryLock(now, {
      prismaClient: prisma,
      sendPushNudgeToCreatorImpl: async () => {
        throw new Error("Sent duplicate should not send.");
      },
    });
    assert.equal(after.status, "done");
    assert.equal(after.skippedDuplicate, 1);
  } finally {
    releaseSend();
    await restorePushSubscriptions(disabledSubscriptionIds);
    await restorePushSchedules(disabledCreatorIds);
    await cleanupPushFixture(fixture);
  }
});

test("a throwing creator does not block others or consume the reservation", async () => {
  const throwing = await createPushFixture("throwing-creator");
  const healthy = await createPushFixture("healthy-creator");
  const disabledCreatorIds = await disableOtherPushSchedules([
    throwing.creatorId,
    healthy.creatorId,
  ]);
  const disabledSubscriptionIds = await disableOtherPushSubscriptions([
    throwing.creatorId,
    healthy.creatorId,
  ]);
  const now = new Date("2026-07-29T09:05:00.000Z");

  try {
    const first = await runPushTick(now, {
      prismaClient: prisma,
      sendPushNudgeToCreatorImpl: async (creatorId) => {
        if (creatorId === throwing.creatorId) {
          throw new Error("creator send exploded");
        }

        return sentPushResult(creatorId, "projects/test/messages/healthy");
      },
    });

    assert.equal(first.sent, 1);
    assert.equal(first.failures, 1);

    const thrownLog = await findNudgeLog(
      throwing.creatorId,
      "post",
      postDedupeKey(throwing.clipId, DEFAULT_POST_SLOT),
    );
    assert.equal(thrownLog?.status, "failed");
    assert.equal(thrownLog?.sentAt, null);

    const healthyLog = await findNudgeLog(
      healthy.creatorId,
      "post",
      postDedupeKey(healthy.clipId, DEFAULT_POST_SLOT),
    );
    assert.equal(healthyLog?.status, "sent");
    assert.ok(healthyLog?.sentAt);

    const retriedCreators: string[] = [];
    const second = await runPushTick(now, {
      prismaClient: prisma,
      sendPushNudgeToCreatorImpl: async (creatorId) => {
        retriedCreators.push(creatorId);
        return sentPushResult(creatorId, "projects/test/messages/retried");
      },
    });

    assert.equal(second.sent, 1);
    assert.equal(second.skippedDuplicate, 1);
    assert.deepEqual(retriedCreators, [throwing.creatorId]);

    const retriedLog = await findNudgeLog(
      throwing.creatorId,
      "post",
      postDedupeKey(throwing.clipId, DEFAULT_POST_SLOT),
    );
    assert.equal(retriedLog?.status, "sent");
    assert.ok(retriedLog?.sentAt);
  } finally {
    await restorePushSubscriptions(disabledSubscriptionIds);
    await restorePushSchedules(disabledCreatorIds);
    await cleanupPushFixture(healthy);
    await cleanupPushFixture(throwing);
  }
});

test("rescheduled clips re-nudge with a slot-timestamp dedupe key", async () => {
  const fixture = await createPushFixture("reschedule");
  const disabledCreatorIds = await disableOtherPushSchedules([fixture.creatorId]);
  const disabledSubscriptionIds = await disableOtherPushSubscriptions([
    fixture.creatorId,
  ]);
  const firstNow = new Date("2026-07-29T09:05:00.000Z");
  const rescheduledFor = new Date("2026-07-29T13:00:00.000Z");
  const secondNow = new Date("2026-07-29T13:05:00.000Z");
  const dedupeKeys: string[] = [];

  try {
    const first = await runPushTick(firstNow, {
      prismaClient: prisma,
      sendPushNudgeToCreatorImpl: async (creatorId, nudge) => {
        dedupeKeys.push(nudge.dedupeKey);
        return sentPushResult(creatorId, "projects/test/messages/first-slot");
      },
    });
    assert.equal(first.sent, 1);

    await prisma.clip.update({
      where: {
        id: fixture.clipId,
      },
      data: {
        scheduledFor: rescheduledFor,
      },
    });

    const second = await runPushTick(secondNow, {
      prismaClient: prisma,
      sendPushNudgeToCreatorImpl: async (creatorId, nudge) => {
        dedupeKeys.push(nudge.dedupeKey);
        return sentPushResult(creatorId, "projects/test/messages/second-slot");
      },
    });
    assert.equal(second.sent, 1);
    assert.deepEqual(dedupeKeys, [
      postDedupeKey(fixture.clipId, DEFAULT_POST_SLOT),
      postDedupeKey(fixture.clipId, rescheduledFor),
    ]);

    const logCount = await prisma.nudgeLog.count({
      where: {
        creatorId: fixture.creatorId,
        kind: "post",
        status: "sent",
      },
    });
    assert.equal(logCount, 2);
  } finally {
    await restorePushSubscriptions(disabledSubscriptionIds);
    await restorePushSchedules(disabledCreatorIds);
    await cleanupPushFixture(fixture);
  }
});

test("failed upload retry generations re-nudge", async () => {
  const fixture = await createFailedPushFixture("retry-generation");
  const disabledCreatorIds = await disableOtherPushSchedules([fixture.creatorId]);
  const disabledSubscriptionIds = await disableOtherPushSubscriptions([
    fixture.creatorId,
  ]);
  const now = new Date("2026-07-29T09:15:00.000Z");
  const dedupeKeys: string[] = [];

  try {
    const first = await runPushTick(now, {
      prismaClient: prisma,
      sendPushNudgeToCreatorImpl: async (creatorId, nudge) => {
        dedupeKeys.push(nudge.dedupeKey);
        return sentPushResult(creatorId, "projects/test/messages/failed-zero");
      },
    });
    assert.equal(first.sent, 1);

    await prisma.video.update({
      where: {
        id: fixture.videoId,
      },
      data: {
        pipelineRetryGeneration: {
          increment: 1,
        },
      },
    });

    const second = await runPushTick(now, {
      prismaClient: prisma,
      sendPushNudgeToCreatorImpl: async (creatorId, nudge) => {
        dedupeKeys.push(nudge.dedupeKey);
        return sentPushResult(creatorId, "projects/test/messages/failed-one");
      },
    });
    assert.equal(second.sent, 1);
    assert.deepEqual(dedupeKeys, [
      `${fixture.videoId}:0`,
      `${fixture.videoId}:1`,
    ]);
  } finally {
    await restorePushSubscriptions(disabledSubscriptionIds);
    await restorePushSchedules(disabledCreatorIds);
    await cleanupPushFixture(fixture);
  }
});

test("push tick sends pipeline done nudges keyed by video id", async () => {
  const fixture = await createDonePushFixture("pipeline-done");
  const disabledCreatorIds = await disableOtherPushSchedules([fixture.creatorId]);
  const disabledSubscriptionIds = await disableOtherPushSubscriptions([
    fixture.creatorId,
  ]);
  const now = new Date("2026-07-29T09:15:00.000Z");
  let sendCalls = 0;

  try {
    const result = await runPushTick(now, {
      prismaClient: prisma,
      sendPushNudgeToCreatorImpl: async (creatorId, nudge) => {
        sendCalls += 1;
        assert.equal(creatorId, fixture.creatorId);
        assert.equal(nudge.kind, "pipeline_done");
        assert.equal(nudge.dedupeKey, fixture.videoId);
        assert.equal(nudge.href, `/review/${fixture.videoId}`);
        return sentPushResult(creatorId, "projects/test/messages/done");
      },
    });

    assert.equal(result.sent, 1);
    assert.equal(sendCalls, 1);

    const log = await findNudgeLog(
      fixture.creatorId,
      "pipeline_done",
      fixture.videoId,
    );
    assert.equal(log?.status, "sent");
  } finally {
    await restorePushSubscriptions(disabledSubscriptionIds);
    await restorePushSchedules(disabledCreatorIds);
    await cleanupPushFixture(fixture);
  }
});

test("push send disables subscriptions on invalid FCM token responses", async () => {
  const fixture = await createPushFixture("invalid-token");
  resetFcmAccessTokenCacheForTests();

  try {
    const result = await sendPushNudgeToCreator(
      fixture.creatorId,
      samplePostNudge(fixture.clipId),
      {
        prismaClient: prisma,
        env: fakeFcmEnv(),
        fetchImpl: fakeInvalidFcmFetch,
        now: new Date("2026-07-29T09:10:00.000Z"),
      },
    );

    assert.equal(result.attempted, 1);
    assert.equal(result.sent, 0);
    assert.equal(result.disabled, 1);
    assert.equal(result.failures[0]?.errorCode, "UNREGISTERED");

    const subscription = await prisma.pushSubscription.findFirstOrThrow({
      where: {
        creatorId: fixture.creatorId,
      },
      select: {
        disabledAt: true,
      },
    });
    assert.ok(subscription.disabledAt);
  } finally {
    resetFcmAccessTokenCacheForTests();
    await cleanupPushFixture(fixture);
  }
});

test("push send does not disable subscriptions on INVALID_ARGUMENT", async () => {
  const fixture = await createPushFixture("invalid-argument");
  resetFcmAccessTokenCacheForTests();

  try {
    const result = await sendPushNudgeToCreator(
      fixture.creatorId,
      samplePostNudge(fixture.clipId),
      {
        prismaClient: prisma,
        env: fakeFcmEnv(),
        fetchImpl: fakeInvalidArgumentFcmFetch,
        now: new Date("2026-07-29T09:10:00.000Z"),
      },
    );

    assert.equal(result.attempted, 1);
    assert.equal(result.sent, 0);
    assert.equal(result.disabled, 0);
    assert.equal(result.failures[0]?.errorCode, "INVALID_ARGUMENT");

    const subscription = await prisma.pushSubscription.findFirstOrThrow({
      where: {
        creatorId: fixture.creatorId,
      },
      select: {
        disabledAt: true,
      },
    });
    assert.equal(subscription.disabledAt, null);
  } finally {
    resetFcmAccessTokenCacheForTests();
    await cleanupPushFixture(fixture);
  }
});

async function createPushFixture(
  label: string,
  overrides: {
    renderedUrl?: string | null;
    postCopyVariants?: Record<string, string> | null;
  } = {},
): Promise<PushFixture> {
  const marker = `push-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const creator = await prisma.creator.create({
    data: {
      accessCode: `${marker}-code`,
      channelUrl: `https://example.com/${marker}`,
      captionStyle: {
        preset: "clean-bold",
      },
    },
  });
  const video = await prisma.video.create({
    data: {
      creatorId: creator.id,
      contentKey: `${marker}-video`,
      sourceUrl: "https://example.com/source.mp4",
      status: "clipped",
    },
  });
  const clip = await prisma.clip.create({
    data: {
      creatorId: creator.id,
      videoId: video.id,
      startMs: 1_000,
      endMs: 10_000,
      status: "scheduled",
      scheduledFor: DEFAULT_POST_SLOT,
      renderedUrl:
        overrides.renderedUrl === undefined
          ? `https://cdn.example/clips/${marker}.mp4`
          : overrides.renderedUrl,
      postCopyVariants:
        overrides.postCopyVariants === undefined
          ? readyPostCopy(marker)
          : overrides.postCopyVariants === null
            ? Prisma.DbNull
            : overrides.postCopyVariants,
    },
  });
  await prisma.schedule.create({
    data: {
      creatorId: creator.id,
      slots: [],
      rotation: {},
      slotsPerDay: 2,
      anchorHour: 9,
      runwayWarnings: false,
      pushNudges: true,
    },
  });
  await prisma.pushSubscription.create({
    data: {
      creatorId: creator.id,
      token: `${marker}-token`,
      userAgent: "node-test",
    },
  });

  return {
    creatorId: creator.id,
    videoId: video.id,
    clipId: clip.id,
  };
}

async function createDonePushFixture(label: string): Promise<PushFixture> {
  const marker = `push-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const creator = await prisma.creator.create({
    data: {
      accessCode: `${marker}-code`,
      channelUrl: `https://example.com/${marker}`,
      captionStyle: {
        preset: "clean-bold",
      },
    },
  });
  const video = await prisma.video.create({
    data: {
      creatorId: creator.id,
      contentKey: `${marker}-video`,
      sourceUrl: "https://example.com/source.mp4",
      status: "clipped",
      pipelineStage: "done",
    },
  });
  await prisma.schedule.create({
    data: {
      creatorId: creator.id,
      slots: [],
      rotation: {},
      slotsPerDay: 2,
      anchorHour: 9,
      reviewReminders: false,
      runwayWarnings: false,
      postTimeNudges: false,
      pushNudges: true,
    },
  });
  await prisma.pushSubscription.create({
    data: {
      creatorId: creator.id,
      token: `${marker}-token`,
      userAgent: "node-test",
    },
  });

  return {
    creatorId: creator.id,
    videoId: video.id,
    clipId: "",
  };
}

async function createFailedPushFixture(label: string): Promise<PushFixture> {
  const marker = `push-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const creator = await prisma.creator.create({
    data: {
      accessCode: `${marker}-code`,
      channelUrl: `https://example.com/${marker}`,
      captionStyle: {
        preset: "clean-bold",
      },
    },
  });
  const video = await prisma.video.create({
    data: {
      creatorId: creator.id,
      contentKey: `${marker}-video`,
      sourceUrl: "https://example.com/source.mp4",
      status: "uploaded",
      pipelineStage: "failed",
      pipelineError: "captions: LLM call failed.",
    },
  });
  await prisma.schedule.create({
    data: {
      creatorId: creator.id,
      slots: [],
      rotation: {},
      slotsPerDay: 2,
      anchorHour: 9,
      reviewReminders: false,
      runwayWarnings: false,
      postTimeNudges: false,
      pushNudges: false,
    },
  });
  await prisma.pushSubscription.create({
    data: {
      creatorId: creator.id,
      token: `${marker}-token`,
      userAgent: "node-test",
    },
  });

  return {
    creatorId: creator.id,
    videoId: video.id,
    clipId: "",
  };
}

async function cleanupPushFixture(fixture: PushFixture): Promise<void> {
  await prisma.nudgeLog.deleteMany({
    where: {
      creatorId: fixture.creatorId,
    },
  });
  await prisma.pushSubscription.deleteMany({
    where: {
      creatorId: fixture.creatorId,
    },
  });
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

async function disableOtherPushSchedules(
  excludedCreatorIds: string[],
): Promise<string[]> {
  const schedules = await prisma.schedule.findMany({
    where: {
      creatorId: {
        notIn: excludedCreatorIds,
      },
      pushNudges: true,
    },
    select: {
      creatorId: true,
    },
  });
  const creatorIds = schedules.map((schedule) => schedule.creatorId);
  if (creatorIds.length > 0) {
    await prisma.schedule.updateMany({
      where: {
        creatorId: {
          in: creatorIds,
        },
      },
      data: {
        pushNudges: false,
      },
    });
  }

  return creatorIds;
}

async function restorePushSchedules(creatorIds: string[]): Promise<void> {
  if (creatorIds.length === 0) {
    return;
  }

  await prisma.schedule.updateMany({
    where: {
      creatorId: {
        in: creatorIds,
      },
    },
    data: {
      pushNudges: true,
    },
  });
}

async function disableOtherPushSubscriptions(
  excludedCreatorIds: string[],
): Promise<string[]> {
  const subscriptions = await prisma.pushSubscription.findMany({
    where: {
      creatorId: {
        notIn: excludedCreatorIds,
      },
      disabledAt: null,
    },
    select: {
      id: true,
    },
  });
  const subscriptionIds = subscriptions.map((subscription) => subscription.id);
  if (subscriptionIds.length > 0) {
    await prisma.pushSubscription.updateMany({
      where: {
        id: {
          in: subscriptionIds,
        },
      },
      data: {
        disabledAt: new Date("2026-07-29T00:00:00.000Z"),
      },
    });
  }

  return subscriptionIds;
}

async function restorePushSubscriptions(subscriptionIds: string[]): Promise<void> {
  if (subscriptionIds.length === 0) {
    return;
  }

  await prisma.pushSubscription.updateMany({
    where: {
      id: {
        in: subscriptionIds,
      },
    },
    data: {
      disabledAt: null,
    },
  });
}

function samplePostNudge(clipId: string): DueNudge {
  const nudge = computeDueNudges(
    {
      id: "creator",
      reviewCount: 0,
      queuedClipCount: 1,
      schedule: {
        slotsPerDay: 2,
        reviewReminders: true,
        runwayWarnings: false,
        runwayThresholdDays: 2,
        postTimeNudges: true,
      },
      scheduledClips: [
        {
          id: clipId,
          scheduledFor: new Date("2026-07-29T09:00:00.000Z"),
          status: "scheduled",
        },
      ],
    },
    new Date("2026-07-29T09:05:00.000Z"),
  )[0];

  assert.ok(nudge);
  return nudge;
}

function sentPushResult(creatorId: string, messageId: string) {
  return {
    creatorId,
    attempted: 1,
    sent: 1,
    disabled: 0,
    failures: [],
    messageIds: [messageId],
  };
}

function postDedupeKey(clipId: string, scheduledFor: Date): string {
  return `${clipId}:${scheduledFor.toISOString()}`;
}

function readyPostCopy(label: string) {
  return {
    youtube: `${label} title`,
    tiktok: `${label} for TikTok #clipmind`,
    instagram: `${label} on Instagram.\nExtra context here\n\n#clipmind`,
  };
}

async function findNudgeLog(
  creatorId: string,
  kind: string,
  dedupeKey: string,
) {
  return prisma.nudgeLog.findUnique({
    where: {
      creatorId_kind_dedupeKey: {
        creatorId,
        kind,
        dedupeKey,
      },
    },
    select: {
      status: true,
      sentAt: true,
      lastFailureAt: true,
      lastFailure: true,
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

function fakeFcmEnv() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  return {
    FCM_PROJECT_ID: "test-project",
    FCM_CLIENT_EMAIL: "test@example.iam.gserviceaccount.com",
    FCM_PRIVATE_KEY: privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string,
  };
}

const fakeInvalidFcmFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url === "https://oauth2.googleapis.com/token") {
    return new Response(
      JSON.stringify({
        access_token: "test-access-token",
        expires_in: 3600,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }

  assert.match(url, /https:\/\/fcm\.googleapis\.com\/v1\/projects\/test-project\/messages:send/);
  return new Response(
    JSON.stringify({
      error: {
        code: 404,
        status: "NOT_FOUND",
        details: [
          {
            "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
            errorCode: "UNREGISTERED",
          },
        ],
      },
    }),
    {
      status: 404,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
};

const fakeInvalidArgumentFcmFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url === "https://oauth2.googleapis.com/token") {
    return new Response(
      JSON.stringify({
        access_token: "test-access-token",
        expires_in: 3600,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }

  assert.match(url, /https:\/\/fcm\.googleapis\.com\/v1\/projects\/test-project\/messages:send/);
  return new Response(
    JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        details: [
          {
            "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
            errorCode: "INVALID_ARGUMENT",
          },
        ],
      },
    }),
    {
      status: 400,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
};
