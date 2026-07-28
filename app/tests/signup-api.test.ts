import test from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../lib/db";
import {
  CREATOR_ACCESS_COOKIE,
  loadCreatorSessionForAccessCode,
} from "../lib/review-auth";
import {
  SIGNUP_CREATOR_COOKIE,
  claimInviteCode,
  handleClaimInvite,
  handleCreateSignupAccount,
} from "../lib/signup";

type SignupFixture = {
  code: string;
  creatorIds: string[];
};

test("invite claim is atomic and rejects double use", async () => {
  const fixture = await createInviteFixture();

  try {
    const results = await Promise.allSettled([
      claimInviteCode(fixture.code, { prismaClient: prisma }),
      claimInviteCode(fixture.code, { prismaClient: prisma }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    if (fulfilled[0]?.status === "fulfilled") {
      fixture.creatorIds.push(fulfilled[0].value.creatorId);
    }

    const invite = await prisma.inviteCode.findUniqueOrThrow({
      where: {
        code: fixture.code,
      },
      select: {
        usedByCreatorId: true,
        usedAt: true,
      },
    });

    assert.ok(invite.usedByCreatorId);
    assert.ok(invite.usedAt);
  } finally {
    await cleanupSignupFixture(fixture);
  }
});

test("signup validation rejects bad invite and profile payloads", async () => {
  const fixture = await createInviteFixture();

  try {
    const badInvite = await handleClaimInvite(
      jsonRequest("http://localhost/api/signup/claim-invite", {
        code: "",
      }),
      { prismaClient: prisma },
    );
    assert.equal(badInvite.status, 400);

    const claim = await handleClaimInvite(
      jsonRequest("http://localhost/api/signup/claim-invite", {
        code: fixture.code,
      }),
      { prismaClient: prisma },
    );
    assert.equal(claim.status, 200);
    const signupCookie = firstCookieValue(claim, SIGNUP_CREATOR_COOKIE);
    assert.ok(signupCookie);
    fixture.creatorIds.push(signupCookie);

    for (const payload of [
      {
        displayName: "",
        channelUrl: "",
        captionPreset: "clean-bold",
      },
      {
        displayName: "Judge",
        channelUrl: "ftp://example.com/channel",
        captionPreset: "clean-bold",
      },
      {
        displayName: "Judge",
        channelUrl: "",
        captionPreset: "unknown",
      },
    ]) {
      const response = await handleCreateSignupAccount(
        jsonRequest("http://localhost/api/signup/create-account", payload, {
          cookie: `${SIGNUP_CREATOR_COOKIE}=${encodeURIComponent(signupCookie)}`,
        }),
        { prismaClient: prisma },
      );
      assert.equal(response.status, 400);
    }
  } finally {
    await cleanupSignupFixture(fixture);
  }
});

test("signup completion returns access code once and sets creator session cookie", async () => {
  const fixture = await createInviteFixture();

  try {
    const claim = await handleClaimInvite(
      jsonRequest("http://localhost/api/signup/claim-invite", {
        code: fixture.code,
      }),
      { prismaClient: prisma },
    );
    assert.equal(claim.status, 200);
    const creatorId = firstCookieValue(claim, SIGNUP_CREATOR_COOKIE);
    assert.ok(creatorId);
    fixture.creatorIds.push(creatorId);

    const response = await handleCreateSignupAccount(
      jsonRequest(
        "http://localhost/api/signup/create-account",
        {
          displayName: "Judge Creator",
          channelUrl: "https://example.com/judge",
          captionPreset: "karaoke",
        },
        {
          cookie: `${SIGNUP_CREATOR_COOKIE}=${encodeURIComponent(creatorId)}`,
        },
      ),
      {
        prismaClient: prisma,
        generateAccessCode: () => "cm-test-code-1234",
      },
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      accessCode: string;
      creatorId: string;
    };
    assert.equal(body.accessCode, "cm-test-code-1234");
    assert.equal(body.creatorId, creatorId);
    assert.equal(
      firstCookieValue(response, CREATOR_ACCESS_COOKIE),
      body.accessCode,
    );
    assert.equal(firstCookieValue(response, SIGNUP_CREATOR_COOKIE), "");

    const session = await loadCreatorSessionForAccessCode(body.accessCode, {
      prismaClient: prisma,
    });
    assert.deepEqual(session, {
      creatorId,
      accessCode: body.accessCode,
    });

    const creator = await prisma.creator.findUniqueOrThrow({
      where: {
        id: creatorId,
      },
      select: {
        displayName: true,
        channelUrl: true,
        captionStyle: true,
        mindStage: true,
      },
    });
    assert.equal(creator.displayName, "Judge Creator");
    assert.equal(creator.channelUrl, "https://example.com/judge");
    assert.deepEqual(creator.captionStyle, {
      preset: "karaoke",
    });
    assert.equal(creator.mindStage, "pending");
  } finally {
    await cleanupSignupFixture(fixture);
  }
});

test("signup account route requires a claimed invite cookie", async () => {
  const response = await handleCreateSignupAccount(
    jsonRequest("http://localhost/api/signup/create-account", {
      displayName: "No Invite",
      channelUrl: "",
      captionPreset: "clean-bold",
    }),
    { prismaClient: prisma },
  );

  assert.equal(response.status, 401);
});

async function createInviteFixture(): Promise<SignupFixture> {
  const marker = `signup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const invite = await prisma.inviteCode.create({
    data: {
      code: marker,
      note: "signup test",
    },
    select: {
      code: true,
    },
  });

  return {
    code: invite.code,
    creatorIds: [],
  };
}

async function cleanupSignupFixture(fixture: SignupFixture): Promise<void> {
  await prisma.inviteCode.deleteMany({
    where: {
      code: fixture.code,
    },
  });
  if (fixture.creatorIds.length > 0) {
    await prisma.creator.deleteMany({
      where: {
        id: {
          in: fixture.creatorIds,
        },
      },
    });
  }
}

function jsonRequest(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

function firstCookieValue(response: Response, name: string): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(new RegExp(`${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1] ?? "") : "";
}
