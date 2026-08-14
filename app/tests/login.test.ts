import "./helpers/db-test-guard";

import test from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../lib/db";
import { loginCreatorWithAccessCode } from "../lib/login";

test("login pre-fills missing timezone without overwriting an existing timezone", async () => {
  const marker = `login-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const existingTimezone = await prisma.creator.create({
    data: {
      accessCode: `${marker}-existing`,
      timezone: "Asia/Bangkok",
    },
  });
  const missingTimezone = await prisma.creator.create({
    data: {
      accessCode: `${marker}-missing`,
    },
  });

  try {
    const existingSession = await loginCreatorWithAccessCode(
      existingTimezone.accessCode ?? "",
      "America/New_York",
      {
        prismaClient: prisma,
      },
    );
    assert.deepEqual(existingSession, {
      creatorId: existingTimezone.id,
      accessCode: existingTimezone.accessCode,
    });

    const unchanged = await prisma.creator.findUniqueOrThrow({
      where: {
        id: existingTimezone.id,
      },
      select: {
        timezone: true,
      },
    });
    assert.equal(unchanged.timezone, "Asia/Bangkok");

    const missingSession = await loginCreatorWithAccessCode(
      missingTimezone.accessCode ?? "",
      "America/New_York",
      {
        prismaClient: prisma,
      },
    );
    assert.deepEqual(missingSession, {
      creatorId: missingTimezone.id,
      accessCode: missingTimezone.accessCode,
    });

    const filled = await prisma.creator.findUniqueOrThrow({
      where: {
        id: missingTimezone.id,
      },
      select: {
        timezone: true,
      },
    });
    assert.equal(filled.timezone, "America/New_York");
  } finally {
    await prisma.creator.deleteMany({
      where: {
        id: {
          in: [existingTimezone.id, missingTimezone.id],
        },
      },
    });
  }
});
