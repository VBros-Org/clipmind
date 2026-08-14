import "./helpers/db-test-guard";

import test from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../lib/db";
import {
  CREATOR_ACCESS_COOKIE,
  loadCreatorSessionForAccessCode,
} from "../lib/review-auth";
import {
  handleRevealCreatorAccessCode,
  handleSessionHeartbeat,
} from "../lib/session";
import {
  SIGNUP_CREATOR_COOKIE,
  claimInviteCode,
  handleClaimInvite,
  handleCreateSignupAccount,
  handleGetSignupSession,
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
          timezone: "Asia/Bangkok",
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
    assert.equal(firstCookieValue(response, SIGNUP_CREATOR_COOKIE), creatorId);

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
        timezone: true,
      },
    });
    assert.equal(creator.displayName, "Judge Creator");
    assert.equal(creator.channelUrl, "https://example.com/judge");
    assert.deepEqual(creator.captionStyle, {
      preset: "karaoke",
    });
    assert.equal(creator.timezone, "Asia/Bangkok");
    assert.equal(creator.mindStage, "pending");
  } finally {
    await cleanupSignupFixture(fixture);
  }
});

test("signup access code creation is compare-and-set under double submit", async () => {
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

    const barrier = createBarrier(2);
    const generatedCodes = ["cm-race-code-a", "cm-race-code-b"];
    const payload = {
      displayName: "Race Creator",
      channelUrl: "https://example.com/race",
      captionPreset: "clean-bold",
      timezone: "Asia/Bangkok",
    };
    const submit = () =>
      handleCreateSignupAccount(
        jsonRequest("http://localhost/api/signup/create-account", payload, {
          cookie: `${SIGNUP_CREATOR_COOKIE}=${encodeURIComponent(creatorId)}`,
        }),
        {
          prismaClient: prisma,
          generateAccessCode: () => generatedCodes.shift() ?? "cm-race-fallback",
          beforeAccessCodeUpdate: barrier,
        },
      );

    const responses = await Promise.all([submit(), submit()]);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
    );

    const success = responses.find((response) => response.status === 200);
    assert.ok(success);
    const body = (await success.json()) as {
      accessCode: string;
    };

    const creator = await prisma.creator.findUniqueOrThrow({
      where: {
        id: creatorId,
      },
      select: {
        accessCode: true,
      },
    });
    assert.equal(creator.accessCode, body.accessCode);
  } finally {
    await cleanupSignupFixture(fixture);
  }
});

test("signup session resumes burned invite and later reveals code with rolled cookie", async () => {
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

    const resumeAfterClaim = await handleGetSignupSession(
      requestWithCookie(
        "http://localhost/api/signup/session",
        SIGNUP_CREATOR_COOKIE,
        creatorId,
      ),
      { prismaClient: prisma },
    );
    assert.equal(resumeAfterClaim.status, 200);
    assert.deepEqual(await resumeAfterClaim.json(), {
      step: "profile",
      creatorId,
      profile: {
        displayName: "",
        channelUrl: "",
        captionPreset: "clean-bold",
        captionCorpus: "",
        channelPullStatus: {
          stage: null,
          error: null,
          errorCode: null,
        },
      },
    });

    const complete = await handleCreateSignupAccount(
      jsonRequest(
        "http://localhost/api/signup/create-account",
        {
          displayName: "Resume Creator",
          channelUrl: "https://example.com/resume",
          captionPreset: "outline-pop",
          timezone: "Asia/Bangkok",
        },
        {
          cookie: `${SIGNUP_CREATOR_COOKIE}=${encodeURIComponent(creatorId)}`,
        },
      ),
      {
        prismaClient: prisma,
        generateAccessCode: () => "cm-resume-code-1234",
      },
    );
    assert.equal(complete.status, 200);
    const completeBody = (await complete.json()) as {
      accessCode: string;
      creatorId: string;
    };
    assert.equal(completeBody.creatorId, creatorId);
    assert.equal(completeBody.accessCode, "cm-resume-code-1234");
    assert.equal(firstCookieValue(complete, SIGNUP_CREATOR_COOKIE), creatorId);

    const resumeAfterComplete = await handleGetSignupSession(
      requestWithCookie(
        "http://localhost/api/signup/session",
        SIGNUP_CREATOR_COOKIE,
        creatorId,
      ),
      { prismaClient: prisma },
    );
    assert.equal(resumeAfterComplete.status, 200);
    assert.deepEqual(await resumeAfterComplete.json(), {
      step: "access",
      creatorId,
      accessCode: completeBody.accessCode,
      profile: {
        displayName: "Resume Creator",
        channelUrl: "https://example.com/resume",
        captionPreset: "outline-pop",
        captionCorpus: "",
        channelPullStatus: {
          stage: null,
          error: null,
          errorCode: null,
        },
      },
    });

    const reveal = await handleRevealCreatorAccessCode(
      requestWithCookie(
        "http://localhost/api/session/access-code",
        CREATOR_ACCESS_COOKIE,
        completeBody.accessCode,
      ),
      { prismaClient: prisma },
    );
    assert.equal(reveal.status, 200);
    assert.deepEqual(await reveal.json(), {
      accessCode: completeBody.accessCode,
    });
    const refreshedCookie = reveal.headers.get("set-cookie") ?? "";
    assert.match(refreshedCookie, new RegExp(`${CREATOR_ACCESS_COOKIE}=`));
    assert.match(refreshedCookie, /Max-Age=2592000/);

    const heartbeat = await handleSessionHeartbeat(
      requestWithCookie(
        "http://localhost/api/session/heartbeat",
        CREATOR_ACCESS_COOKIE,
        completeBody.accessCode,
      ),
      { prismaClient: prisma },
    );
    assert.equal(heartbeat.status, 204);
    const heartbeatCookie = heartbeat.headers.get("set-cookie") ?? "";
    assert.match(heartbeatCookie, new RegExp(`${CREATOR_ACCESS_COOKIE}=`));
    assert.match(heartbeatCookie, /Max-Age=2592000/);

    const heartbeatUnauthed = await handleSessionHeartbeat(
      new Request("http://localhost/api/session/heartbeat", {
        method: "POST",
      }),
      { prismaClient: prisma },
    );
    assert.equal(heartbeatUnauthed.status, 401);
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

function requestWithCookie(url: string, name: string, value: string): Request {
  return new Request(url, {
    headers: {
      cookie: `${name}=${encodeURIComponent(value)}`,
    },
  });
}

function firstCookieValue(response: Response, name: string): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(new RegExp(`${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1] ?? "") : "";
}

function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    arrived += 1;
    if (arrived === parties) {
      release();
    }
    await promise;
  };
}
