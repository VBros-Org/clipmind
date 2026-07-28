import test from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../lib/db";
import { cookieHeaderForAccessCode } from "../lib/review-auth";
import {
  handleAcceptClip,
  handleGetClip,
  handleMarkClipPosted,
  handleRejectClip,
} from "../lib/review-api";

type ReviewFixture = {
  creatorAId: string;
  creatorBId: string;
  creatorACode: string;
  creatorBCode: string;
  clipId: string;
};

test("clip API rejects missing cookies and cross creator access", async () => {
  const fixture = await createFixture();

  try {
    const noCookie = await handleGetClip(
      new Request(`http://localhost/api/clips/${fixture.clipId}`),
      { id: fixture.clipId },
    );
    assert.equal(noCookie.status, 401);

    const crossCreator = await handleGetClip(
      requestWithCode(fixture.clipId, fixture.creatorBCode),
      { id: fixture.clipId },
    );
    assert.equal(crossCreator.status, 404);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("accept transitions candidate to accepted and starts one background render", async () => {
  const fixture = await createFixture();
  let renderCalls = 0;
  let resolveRender = () => {};

  try {
    const response = await Promise.race([
      handleAcceptClip(
        requestWithCode(fixture.clipId, fixture.creatorACode, "POST"),
        { id: fixture.clipId },
        {
          renderClipImpl: async (clipId, presetId) => {
            renderCalls += 1;
            assert.equal(clipId, fixture.clipId);
            assert.equal(presetId, "clean-bold");
            await new Promise<void>((resolve) => {
              resolveRender = resolve;
            });
            return {
              clipId,
              videoId: "video-after-render",
              renderedUrl: "https://cdn.example/rendered.mp4",
            };
          },
        },
      ),
      delay(100).then(() => "timeout" as const),
    ]);

    assert.notEqual(response, "timeout");
    assert.equal(renderCalls, 1);
    assert.equal((response as Response).status, 200);

    const body = (await (response as Response).json()) as {
      clip: { status: string };
      rendering: boolean;
    };
    assert.equal(body.clip.status, "accepted");
    assert.equal(body.rendering, true);

    const clip = await prisma.clip.findUniqueOrThrow({
      where: {
        id: fixture.clipId,
      },
      select: {
        status: true,
      },
    });
    assert.equal(clip.status, "accepted");
  } finally {
    resolveRender?.();
    await cleanupFixture(fixture);
  }
});

test("accept triggers deterministic scheduling when rhythm exists", async () => {
  const fixture = await createFixture();

  try {
    await prisma.schedule.create({
      data: {
        creatorId: fixture.creatorAId,
        slots: [],
        rotation: {},
        slotsPerDay: 2,
        anchorHour: 9,
      },
    });

    const response = await handleAcceptClip(
      requestWithCode(fixture.clipId, fixture.creatorACode, "POST"),
      { id: fixture.clipId },
      {
        renderClipImpl: async (clipId) => ({
          clipId,
          videoId: "video-after-render",
          renderedUrl: "https://cdn.example/rendered.mp4",
        }),
      },
    );
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      clip: { status: string };
      scheduledCount: number;
    };
    assert.equal(body.clip.status, "scheduled");
    assert.equal(body.scheduledCount, 1);

    const clip = await prisma.clip.findUniqueOrThrow({
      where: {
        id: fixture.clipId,
      },
      select: {
        status: true,
        scheduledFor: true,
      },
    });
    assert.equal(clip.status, "scheduled");
    assert.ok(clip.scheduledFor);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("reject transitions candidate to rejected and does not render", async () => {
  const fixture = await createFixture();
  let renderCalls = 0;

  try {
    const response = await handleRejectClip(
      requestWithCode(fixture.clipId, fixture.creatorACode, "POST"),
      { id: fixture.clipId },
      {
        renderClipImpl: async () => {
          renderCalls += 1;
          throw new Error("Reject should not render.");
        },
      },
    );
    assert.equal(response.status, 200);
    assert.equal(renderCalls, 0);

    const body = (await response.json()) as { clip: { status: string } };
    assert.equal(body.clip.status, "rejected");

    const clip = await prisma.clip.findUniqueOrThrow({
      where: {
        id: fixture.clipId,
      },
      select: {
        status: true,
      },
    });
    assert.equal(clip.status, "rejected");
  } finally {
    await cleanupFixture(fixture);
  }
});

test("posted API only transitions scheduled clips for the owning creator", async () => {
  const fixture = await createFixture();

  try {
    const candidateResponse = await handleMarkClipPosted(
      requestWithCode(fixture.clipId, fixture.creatorACode, "POST"),
      { id: fixture.clipId },
      {
        now: new Date("2026-07-28T12:00:00.000Z"),
      },
    );
    assert.equal(candidateResponse.status, 409);

    await prisma.clip.update({
      where: {
        id: fixture.clipId,
      },
      data: {
        status: "scheduled",
        scheduledFor: new Date("2026-07-28T11:00:00.000Z"),
      },
    });

    const crossCreator = await handleMarkClipPosted(
      requestWithCode(fixture.clipId, fixture.creatorBCode, "POST"),
      { id: fixture.clipId },
      {
        now: new Date("2026-07-28T12:00:00.000Z"),
      },
    );
    assert.equal(crossCreator.status, 404);

    const response = await handleMarkClipPosted(
      requestWithCode(fixture.clipId, fixture.creatorACode, "POST"),
      { id: fixture.clipId },
      {
        now: new Date("2026-07-28T12:00:00.000Z"),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "posted",
      clipId: fixture.clipId,
      creatorId: fixture.creatorAId,
      videoId: (await prisma.clip.findUniqueOrThrow({
        where: {
          id: fixture.clipId,
        },
        select: {
          videoId: true,
        },
      })).videoId,
      scheduledFor: "2026-07-28T11:00:00.000Z",
      postedAt: "2026-07-28T12:00:00.000Z",
    });

    const postedClip = await prisma.clip.findUniqueOrThrow({
      where: {
        id: fixture.clipId,
      },
      select: {
        status: true,
        postedAt: true,
      },
    });
    assert.equal(postedClip.status, "posted");
    assert.equal(
      postedClip.postedAt?.toISOString(),
      "2026-07-28T12:00:00.000Z",
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test("mutating clip API rejects cross creator access", async () => {
  const fixture = await createFixture();

  try {
    const response = await handleAcceptClip(
      requestWithCode(fixture.clipId, fixture.creatorBCode, "POST"),
      { id: fixture.clipId },
      {
        renderClipImpl: async () => {
          throw new Error("Cross creator accept should not render.");
        },
      },
    );
    assert.equal(response.status, 404);

    const clip = await prisma.clip.findUniqueOrThrow({
      where: {
        id: fixture.clipId,
      },
      select: {
        status: true,
      },
    });
    assert.equal(clip.status, "candidate");
  } finally {
    await cleanupFixture(fixture);
  }
});

async function createFixture(): Promise<ReviewFixture> {
  const marker = `review-api-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  const video = await prisma.video.create({
    data: {
      creatorId: creatorA.id,
      contentKey: `${marker}-video`,
      sourceKey: `videos/${marker}/source.mp4`,
      sourceUrl: "https://example.com/source.mp4",
      status: "clipped",
    },
  });
  const clip = await prisma.clip.create({
    data: {
      creatorId: creatorA.id,
      videoId: video.id,
      startMs: 2_000,
      endMs: 14_000,
      transcript: "This is the candidate clip.",
      mindRank: 2,
      mindRankReason: "Clear payoff.",
      postCopyVariants: {
        youtube: "A clear payoff",
        tiktok: "A clear payoff #clips",
        instagram: "A clear payoff\n\n#clips",
      },
      status: "candidate",
    },
  });

  return {
    creatorAId: creatorA.id,
    creatorBId: creatorB.id,
    creatorACode: creatorA.accessCode ?? "",
    creatorBCode: creatorB.accessCode ?? "",
    clipId: clip.id,
  };
}

async function cleanupFixture(fixture: ReviewFixture): Promise<void> {
  await prisma.schedule.deleteMany({
    where: {
      creatorId: {
        in: [fixture.creatorAId, fixture.creatorBId],
      },
    },
  });
  await prisma.learningEvent.deleteMany({
    where: {
      creatorId: {
        in: [fixture.creatorAId, fixture.creatorBId],
      },
    },
  });
  await prisma.clip.deleteMany({
    where: {
      creatorId: {
        in: [fixture.creatorAId, fixture.creatorBId],
      },
    },
  });
  await prisma.video.deleteMany({
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
  clipId: string,
  accessCode: string,
  method = "GET",
): Request {
  return new Request(`http://localhost/api/clips/${clipId}`, {
    method,
    headers: {
      cookie: cookieHeaderForAccessCode(accessCode),
    },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
