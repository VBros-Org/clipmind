import test from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../lib/db";
import { cookieHeaderForAccessCode } from "../lib/review-auth";
import { handleGetSchedule, handlePutSchedule } from "../lib/schedule-api";
import type { ScheduleSettings } from "../lib/schedule-settings";

type ScheduleFixture = {
  creatorAId: string;
  creatorBId: string;
  creatorACode: string;
  creatorBCode: string;
};

const validSettings: ScheduleSettings = {
  slotsPerDay: 2,
  anchorHour: 9,
  slotTimes: ["09:15", "19:45"],
  reviewReminders: true,
  runwayWarnings: true,
  runwayThresholdDays: 3,
  postTimeNudges: false,
  pushNudges: false,
};

test("schedule API requires auth and validates settings ranges", async () => {
  const fixture = await createFixture();

  try {
    const noCookie = await handleGetSchedule(
      new Request("http://localhost/api/schedule"),
    );
    assert.equal(noCookie.status, 401);

    const invalidCases = [
      { ...validSettings, slotsPerDay: 0 },
      { ...validSettings, slotsPerDay: 5 },
      { ...validSettings, anchorHour: -1 },
      { ...validSettings, anchorHour: 24 },
      { ...validSettings, runwayThresholdDays: 0 },
      { ...validSettings, runwayThresholdDays: 8 },
      { ...validSettings, reviewReminders: "yes" },
      { ...validSettings, pushNudges: "yes" },
      { ...validSettings, slotTimes: [] },
      { ...validSettings, slotTimes: ["09:10", "19:45"] },
      { ...validSettings, slotTimes: ["09:15", "09:15"] },
      { ...validSettings, slotTimes: ["19:45", "09:15"] },
      { ...validSettings, slotTimes: ["9:15", "19:45"] },
      {
        ...validSettings,
        slotTimes: ["00:00", "06:00", "12:00", "18:00", "23:45"],
      },
    ];

    for (const payload of invalidCases) {
      const response = await handlePutSchedule(
        requestWithCode(fixture.creatorACode, "PUT", payload),
      );
      assert.equal(response.status, 400);
    }

    const count = await prisma.schedule.count({
      where: {
        creatorId: fixture.creatorAId,
      },
    });
    assert.equal(count, 0);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("schedule API persists rhythm per creator and does not leak across creators", async () => {
  const fixture = await createFixture();

  try {
    const putResponse = await handlePutSchedule(
      requestWithCode(fixture.creatorACode, "PUT", {
        ...validSettings,
        timezone: "Asia/Bangkok",
      }),
    );
    assert.equal(putResponse.status, 200);

    const putBody = (await putResponse.json()) as {
      schedule: ScheduleSettings;
      scheduledCount: number;
    };
    assert.deepEqual(putBody.schedule, validSettings);
    assert.equal(putBody.scheduledCount, 0);

    const storedSchedule = await prisma.schedule.findUniqueOrThrow({
      where: {
        creatorId: fixture.creatorAId,
      },
      select: {
        slots: true,
        slotTimes: true,
        slotsPerDay: true,
      },
    });
    assert.deepEqual(storedSchedule.slots, validSettings.slotTimes);
    assert.deepEqual(storedSchedule.slotTimes, validSettings.slotTimes);
    assert.equal(storedSchedule.slotsPerDay, validSettings.slotTimes?.length);
    const storedCreator = await prisma.creator.findUniqueOrThrow({
      where: {
        id: fixture.creatorAId,
      },
      select: {
        timezone: true,
      },
    });
    assert.equal(storedCreator.timezone, "Asia/Bangkok");

    const creatorAGet = await handleGetSchedule(
      requestWithCode(fixture.creatorACode),
    );
    assert.equal(creatorAGet.status, 200);
    const creatorABody = (await creatorAGet.json()) as {
      schedule: ScheduleSettings | null;
    };
    assert.deepEqual(creatorABody.schedule, validSettings);

    const creatorBGet = await handleGetSchedule(
      requestWithCode(fixture.creatorBCode),
    );
    assert.equal(creatorBGet.status, 200);
    const creatorBBody = (await creatorBGet.json()) as {
      schedule: ScheduleSettings | null;
    };
    assert.equal(creatorBBody.schedule, null);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("schedule API keeps legacy cadence payloads working when slotTimes is omitted", async () => {
  const fixture = await createFixture();

  try {
    const legacyPayload = {
      slotsPerDay: 2,
      anchorHour: 9,
      reviewReminders: true,
      runwayWarnings: true,
      runwayThresholdDays: 3,
      postTimeNudges: false,
      pushNudges: false,
    };
    const response = await handlePutSchedule(
      requestWithCode(fixture.creatorACode, "PUT", legacyPayload),
    );
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      schedule: ScheduleSettings;
    };
    assert.deepEqual(body.schedule, {
      ...legacyPayload,
      slotTimes: null,
    });

    const storedSchedule = await prisma.schedule.findUniqueOrThrow({
      where: {
        creatorId: fixture.creatorAId,
      },
      select: {
        slots: true,
        slotTimes: true,
      },
    });
    assert.deepEqual(storedSchedule.slots, ["09:00", "21:00"]);
    assert.equal(storedSchedule.slotTimes, null);
  } finally {
    await cleanupFixture(fixture);
  }
});

async function createFixture(): Promise<ScheduleFixture> {
  const marker = `schedule-api-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const creatorA = await prisma.creator.create({
    data: {
      accessCode: `${marker}-a`,
      channelUrl: `https://example.com/${marker}/a`,
      captionStyle: {
        preset: "clean-bold",
      },
    },
  });
  const creatorB = await prisma.creator.create({
    data: {
      accessCode: `${marker}-b`,
      channelUrl: `https://example.com/${marker}/b`,
      captionStyle: {
        preset: "clean-bold",
      },
    },
  });

  return {
    creatorAId: creatorA.id,
    creatorBId: creatorB.id,
    creatorACode: creatorA.accessCode ?? "",
    creatorBCode: creatorB.accessCode ?? "",
  };
}

async function cleanupFixture(fixture: ScheduleFixture): Promise<void> {
  await prisma.schedule.deleteMany({
    where: {
      creatorId: {
        in: [fixture.creatorAId, fixture.creatorBId],
      },
    },
  });
  await prisma.creator.deleteMany({
    where: {
      id: {
        in: [fixture.creatorAId, fixture.creatorBId],
      },
    },
  });
}

function requestWithCode(
  accessCode: string,
  method = "GET",
  payload?: unknown,
): Request {
  return new Request("http://localhost/api/schedule", {
    method,
    headers: {
      cookie: cookieHeaderForAccessCode(accessCode),
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
}
