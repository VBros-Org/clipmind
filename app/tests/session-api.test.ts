import test from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import { CREATOR_ACCESS_COOKIE } from "../lib/review-auth";
import { SIGNUP_CREATOR_COOKIE } from "../lib/signup";
import { handleLogoutCreatorSession } from "../lib/session";

test("logout route clears creator cookie and redirects without auth", async () => {
  const response = await handleLogoutCreatorSession();

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/login");
  assert.equal(response.headers.get("cache-control"), "no-store");

  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, new RegExp(`${CREATOR_ACCESS_COOKIE}=`));
  assert.match(setCookie, new RegExp(`${SIGNUP_CREATOR_COOKIE}=`));
  assert.match(setCookie, /Max-Age=0/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /HttpOnly/);
});

test("logout route disables supplied push token for the current creator", async () => {
  const disabledAt = new Date("2026-08-14T10:00:00.000Z");
  const updates: unknown[] = [];
  const prismaClient = {
    creator: {
      findUnique: async (query: unknown) => {
        assert.deepEqual(query, {
          where: {
            accessCode: "creator-code",
          },
          select: {
            id: true,
            accessCode: true,
          },
        });
        return {
          id: "creator_1",
          accessCode: "creator-code",
        };
      },
    },
    pushSubscription: {
      updateMany: async (query: unknown) => {
        updates.push(query);
        return {
          count: 1,
        };
      },
    },
  } as unknown as PrismaClient;

  const response = await handleLogoutCreatorSession(
    new Request("http://localhost/api/session/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${CREATOR_ACCESS_COOKIE}=creator-code`,
      },
      body: JSON.stringify({
        pushToken: "fcm-token-current-device",
      }),
    }),
    {
      prismaClient,
      now: disabledAt,
    },
  );

  assert.equal(response.status, 303);
  assert.deepEqual(updates, [
    {
      where: {
        creatorId: "creator_1",
        token: "fcm-token-current-device",
        disabledAt: null,
      },
      data: {
        disabledAt,
      },
    },
  ]);
});
