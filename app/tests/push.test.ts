import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { prisma } from "../lib/db";
import { computeDueNudges, type DueNudge } from "../lib/nudges";
import { handlePushTick } from "../lib/push-api";
import {
  resetFcmAccessTokenCacheForTests,
  sendPushNudgeToCreator,
} from "../lib/push";
import { runPushTick } from "../lib/push-tick";

type PushFixture = {
  creatorId: string;
  videoId: string;
  clipId: string;
};

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
        dedupeKey: fixture.clipId,
      },
    });
    assert.equal(logCount, 1);
  } finally {
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

async function createPushFixture(label: string): Promise<PushFixture> {
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
      scheduledFor: new Date("2026-07-29T09:00:00.000Z"),
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
