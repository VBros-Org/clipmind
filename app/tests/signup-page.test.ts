import "./helpers/db-test-guard";

import test from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../lib/db";
import { cookieHeaderForAccessCode } from "../lib/review-auth";
import { loadSignedInSignupAffordance } from "../lib/signup-page";

test("signup page shows signed-in affordance for a valid session cookie", async () => {
  const marker = `signup-page-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const accessCode = `cm-${marker}`;
  const creator = await prisma.creator.create({
    data: {
      accessCode,
      displayName: "Judge Creator",
      mindStage: "pending",
    },
    select: {
      id: true,
    },
  });

  try {
    const affordance = await loadSignedInSignupAffordance(
      cookieHeaderForAccessCode(accessCode),
      { prismaClient: prisma },
    );

    assert.deepEqual(affordance, {
      displayName: "Judge Creator",
      message: "Signed in as Judge Creator. Log out to create a new profile.",
    });
  } finally {
    await prisma.creator.delete({
      where: {
        id: creator.id,
      },
    });
  }
});
