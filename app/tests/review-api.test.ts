import test from "node:test";
import assert from "node:assert/strict";

import { Prisma } from "@prisma/client";

import { prisma } from "../lib/db";
import { cookieHeaderForAccessCode } from "../lib/review-auth";
import {
  handleAcceptClip,
  handleGetClip,
  handleMarkClipPosted,
  handleRejectClip,
  handleRetryClipRender,
  handleSetRejectReason,
} from "../lib/review-api";
import { loadHomeOverview } from "../lib/app-overview";
import type { PostCopyVariants } from "../lib/captioning";

type ReviewFixture = {
  creatorAId: string;
  creatorBId: string;
  creatorACode: string;
  creatorBCode: string;
  videoId: string;
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
  let resolveRendered = () => {};
  const rendered = new Promise<void>((resolve) => {
    resolveRendered = resolve;
  });

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
        renderClipImpl: async (clipId) => {
          await prisma.clip.update({
            where: {
              id: clipId,
            },
            data: {
              renderedUrl: "https://cdn.example/rendered.mp4",
            },
          });
          resolveRendered();
          return {
            clipId,
            videoId: fixture.videoId,
            renderedUrl: "https://cdn.example/rendered.mp4",
          };
        },
      },
    );
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      clip: { status: string };
      scheduledCount: number;
    };
    assert.equal(body.clip.status, "accepted");
    assert.equal(body.scheduledCount, 0);

    await rendered;
    const scheduled = await waitForScheduled(fixture.clipId);
    assert.equal(scheduled.status, "scheduled");
    assert.ok(scheduled.scheduledFor);

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

test("accept captions a rank-3 clip before scheduling reaches the post sheet", async () => {
  const fixture = await createFixture({
    mindRank: 3,
    postCopyVariants: null,
  });
  const variants = postCopyVariants("Rank three captioned");
  let captionCalls = 0;
  let resolveRendered = () => {};
  const rendered = new Promise<void>((resolve) => {
    resolveRendered = resolve;
  });

  try {
    await prisma.creator.update({
      where: {
        id: fixture.creatorAId,
      },
      data: {
        mindId: "mind-rank-three",
      },
    });
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
        captionOptions: {
          mindsClient: {
            async sendMessageAndWaitForReply() {
              captionCalls += 1;
              const beforeCaption = await prisma.clip.findUniqueOrThrow({
                where: {
                  id: fixture.clipId,
                },
                select: {
                  status: true,
                  scheduledFor: true,
                  postCopyVariants: true,
                  mindRank: true,
                },
              });
              assert.equal(beforeCaption.status, "accepted");
              assert.equal(beforeCaption.scheduledFor, null);
              assert.equal(beforeCaption.postCopyVariants, null);
              assert.equal(beforeCaption.mindRank, 3);

              return JSON.stringify(variants);
            },
          },
        },
        renderClipImpl: async (clipId) => {
          await prisma.clip.update({
            where: {
              id: clipId,
            },
            data: {
              renderedUrl: "https://cdn.example/rendered-rank-three.mp4",
            },
          });
          resolveRendered();
          return {
            clipId,
            videoId: fixture.videoId,
            renderedUrl: "https://cdn.example/rendered-rank-three.mp4",
          };
        },
      },
    );
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      clip: {
        status: string;
        postCopyVariants: PostCopyVariants | null;
      };
      scheduledCount: number;
    };
    assert.equal(captionCalls, 1);
    assert.equal(body.clip.status, "accepted");
    assert.deepEqual(body.clip.postCopyVariants, variants);
    assert.equal(body.scheduledCount, 0);

    await rendered;
    await waitForScheduled(fixture.clipId);

    const clip = await prisma.clip.findUniqueOrThrow({
      where: {
        id: fixture.clipId,
      },
      select: {
        status: true,
        scheduledFor: true,
        postCopyVariants: true,
      },
    });
    assert.equal(clip.status, "scheduled");
    assert.ok(clip.scheduledFor);
    assert.deepEqual(clip.postCopyVariants, variants);

    const home = await loadHomeOverview(fixture.creatorAId, {
      now: new Date("2026-07-28T12:00:00.000Z"),
    });
    assert.deepEqual(home.readyToPost[0]?.postCopyVariants, variants);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("review verdicts are rejected while the video is still ranking", async () => {
  const fixture = await createFixture({
    pipelineStage: "ranking",
  });

  try {
    const acceptResponse = await handleAcceptClip(
      requestWithCode(fixture.clipId, fixture.creatorACode, "POST"),
      { id: fixture.clipId },
      {
        renderClipImpl: async () => {
          throw new Error("Ranking-stage accept should not render.");
        },
      },
    );
    assert.equal(acceptResponse.status, 409);
    assert.match(
      ((await acceptResponse.json()) as { error: string }).error,
      /not ready for review/,
    );

    const rejectResponse = await handleRejectClip(
      requestWithCode(fixture.clipId, fixture.creatorACode, "POST"),
      { id: fixture.clipId },
    );
    assert.equal(rejectResponse.status, 409);
    assert.match(
      ((await rejectResponse.json()) as { error: string }).error,
      /not ready for review/,
    );

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

test("failed review render lands in retryable state and retry succeeds", async () => {
  const fixture = await createFixture();
  let renderCalls = 0;

  try {
    const acceptResponse = await handleAcceptClip(
      requestWithCode(fixture.clipId, fixture.creatorACode, "POST"),
      { id: fixture.clipId },
      {
        renderClipImpl: async () => {
          renderCalls += 1;
          throw new Error(`renderer killed ${"x".repeat(800)}`);
        },
      },
    );
    assert.equal(acceptResponse.status, 200);

    const failedClip = await waitForRenderFailure(fixture.clipId);
    assert.ok(failedClip.renderFailedAt);
    assert.match(failedClip.renderError ?? "", /^renderer killed /);
    assert.equal((failedClip.renderError ?? "").length, 500);

    const getFailed = await handleGetClip(
      requestWithCode(fixture.clipId, fixture.creatorACode),
      { id: fixture.clipId },
    );
    assert.equal(getFailed.status, 200);
    const failedBody = (await getFailed.json()) as {
      renderFailedAt: string | null;
      renderError: string | null;
    };
    assert.ok(failedBody.renderFailedAt);
    assert.equal(failedBody.renderError?.length, 500);

    const retryResponse = await handleRetryClipRender(
      requestWithCode(fixture.clipId, fixture.creatorACode, "POST"),
      { id: fixture.clipId },
      {
        renderClipImpl: async (clipId) => {
          renderCalls += 1;
          const renderedUrl = `https://cdn.example/clips/${clipId}.mp4`;
          await prisma.clip.update({
            where: {
              id: clipId,
            },
            data: {
              renderedUrl,
              renderFailedAt: null,
              renderError: null,
            },
          });
          return {
            clipId,
            videoId: "video-after-render-retry",
            renderedUrl,
          };
        },
      },
    );
    assert.equal(retryResponse.status, 200);
    const retryBody = (await retryResponse.json()) as {
      clip: {
        renderFailedAt: string | null;
        renderError: string | null;
      };
      rendering: boolean;
    };
    assert.equal(retryBody.rendering, true);
    assert.equal(retryBody.clip.renderFailedAt, null);
    assert.equal(retryBody.clip.renderError, null);

    const renderedClip = await waitForRenderedUrl(fixture.clipId);
    assert.equal(renderedClip.renderedUrl?.endsWith(`${fixture.clipId}.mp4`), true);
    assert.equal(renderedClip.renderFailedAt, null);
    assert.equal(renderedClip.renderError, null);
    assert.equal(renderCalls, 2);
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

test("reject reason stores only after a clip is rejected", async () => {
  const fixture = await createFixture();

  try {
    const tooEarly = await handleSetRejectReason(
      jsonRequestWithCode(
        fixture.clipId,
        fixture.creatorACode,
        {
          rejectReason: "weak moment",
        },
        "PATCH",
      ),
      { id: fixture.clipId },
    );
    assert.equal(tooEarly.status, 409);

    const reject = await handleRejectClip(
      requestWithCode(fixture.clipId, fixture.creatorACode, "POST"),
      { id: fixture.clipId },
    );
    assert.equal(reject.status, 200);

    const response = await handleSetRejectReason(
      jsonRequestWithCode(
        fixture.clipId,
        fixture.creatorACode,
        {
          rejectReason: "weak moment",
        },
        "PATCH",
      ),
      { id: fixture.clipId },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      clip: {
        rejectReason: string | null;
      };
    };
    assert.equal(body.clip.rejectReason, "weak moment");

    const clip = await prisma.clip.findUniqueOrThrow({
      where: {
        id: fixture.clipId,
      },
      select: {
        rejectReason: true,
      },
    });
    assert.equal(clip.rejectReason, "weak moment");
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
        renderedUrl: "https://cdn.example/rendered.mp4",
        postCopyVariants: postCopyVariants("Ready to post"),
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
      postedThisWeek: 1,
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

test("posted API rejects scheduled clips without rendered media or complete captions", async () => {
  const fixture = await createFixture();

  try {
    await prisma.clip.update({
      where: {
        id: fixture.clipId,
      },
      data: {
        status: "scheduled",
        scheduledFor: new Date("2026-07-28T11:00:00.000Z"),
        renderedUrl: null,
        postCopyVariants: postCopyVariants("Captioned but not rendered"),
      },
    });

    const unrendered = await handleMarkClipPosted(
      requestWithCode(fixture.clipId, fixture.creatorACode, "POST"),
      { id: fixture.clipId },
      {
        now: new Date("2026-07-28T12:00:00.000Z"),
      },
    );
    assert.equal(unrendered.status, 409);
    assert.match(
      ((await unrendered.json()) as { error: string }).error,
      /not ready to post/,
    );

    await prisma.clip.update({
      where: {
        id: fixture.clipId,
      },
      data: {
        renderedUrl: "https://cdn.example/rendered.mp4",
        postCopyVariants: Prisma.DbNull,
      },
    });
    const captionless = await handleMarkClipPosted(
      requestWithCode(fixture.clipId, fixture.creatorACode, "POST"),
      { id: fixture.clipId },
      {
        now: new Date("2026-07-28T12:00:00.000Z"),
      },
    );
    assert.equal(captionless.status, 409);

    await prisma.clip.update({
      where: {
        id: fixture.clipId,
      },
      data: {
        postCopyVariants: {
          youtube: "Missing Instagram",
          tiktok: "Missing Instagram #clips",
        },
      },
    });
    const incomplete = await handleMarkClipPosted(
      requestWithCode(fixture.clipId, fixture.creatorACode, "POST"),
      { id: fixture.clipId },
      {
        now: new Date("2026-07-28T12:00:00.000Z"),
      },
    );
    assert.equal(incomplete.status, 409);

    const clip = await prisma.clip.findUniqueOrThrow({
      where: {
        id: fixture.clipId,
      },
      select: {
        status: true,
        postedAt: true,
      },
    });
    assert.equal(clip.status, "scheduled");
    assert.equal(clip.postedAt, null);
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

async function createFixture(
  overrides: {
    mindRank?: number;
    pipelineStage?: string | null;
    postCopyVariants?: PostCopyVariants | Record<string, string> | null;
  } = {},
): Promise<ReviewFixture> {
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
      pipelineStage: overrides.pipelineStage ?? "done",
    },
  });
  const clip = await prisma.clip.create({
    data: {
      creatorId: creatorA.id,
      videoId: video.id,
      startMs: 2_000,
      endMs: 14_000,
      transcript: "This is the candidate clip.",
      mindRank: overrides.mindRank ?? 2,
      mindRankReason: "Clear payoff.",
      ...(overrides.postCopyVariants === null
        ? {}
        : {
            postCopyVariants:
              overrides.postCopyVariants === undefined
                ? postCopyVariants("A clear payoff")
                : overrides.postCopyVariants,
          }),
      status: "candidate",
    },
  });

  return {
    creatorAId: creatorA.id,
    creatorBId: creatorB.id,
    creatorACode: creatorA.accessCode ?? "",
    creatorBCode: creatorB.accessCode ?? "",
    videoId: video.id,
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

function jsonRequestWithCode(
  clipId: string,
  accessCode: string,
  payload: unknown,
  method = "POST",
): Request {
  return new Request(`http://localhost/api/clips/${clipId}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      cookie: cookieHeaderForAccessCode(accessCode),
    },
    body: JSON.stringify(payload),
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function postCopyVariants(label: string): PostCopyVariants {
  return {
    youtube: label,
    tiktok: `${label} hit harder than expected #clips`,
    instagram: `${label} needed the full setup.\nThe payoff lands after the first two picks.\n\n#clips`,
  };
}

async function waitForRenderFailure(clipId: string) {
  return waitForClip(clipId, (clip) => Boolean(clip.renderFailedAt));
}

async function waitForRenderedUrl(clipId: string) {
  return waitForClip(clipId, (clip) => Boolean(clip.renderedUrl));
}

async function waitForScheduled(clipId: string) {
  return waitForClip(clipId, (clip) => clip.status === "scheduled");
}

async function waitForClip(
  clipId: string,
  predicate: (clip: {
    status: string;
    scheduledFor: Date | null;
    renderedUrl: string | null;
    renderFailedAt: Date | null;
    renderError: string | null;
  }) => boolean,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const clip = await prisma.clip.findUniqueOrThrow({
      where: {
        id: clipId,
      },
      select: {
        status: true,
        scheduledFor: true,
        renderedUrl: true,
        renderFailedAt: true,
        renderError: true,
      },
    });
    if (predicate(clip)) {
      return clip;
    }
    await delay(20);
  }

  throw new Error(`Timed out waiting for clip ${clipId}.`);
}
