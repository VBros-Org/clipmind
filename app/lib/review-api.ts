import type { PrismaClient } from "@prisma/client";

import { countPostedThisWeek } from "./posting-stats";
import { ClipReadinessError } from "./readiness";
import { loadCreatorSessionFromCookieHeader } from "./review-auth";
import {
  captionClip,
  type CaptionClipOptions,
} from "./captioning";
import {
  acceptClipForReview,
  loadClipPreview,
  loadReviewClip,
  rejectClipForReview,
  retryRenderForReview,
  setClipRejectReasonForReview,
  startRenderAfterAccept,
  RejectReasonStatusError,
  RenderRetryStatusError,
} from "./review";
import { isRejectReason } from "./reject-reasons";
import type { renderClip } from "./render";
import { markPostedForCreator, runSchedulePass } from "./scheduling-repository";
import type { R2Storage } from "./storage";
import {
  triggerTasteFeedbackSyncAfterVerdict,
  type TriggerTasteFeedbackSyncOptions,
  type TriggerTasteFeedbackSyncResult,
} from "./tasteFeedback";

type RouteParams = { id: string } | Promise<{ id: string }>;

type ReviewApiOptions = {
  prismaClient?: PrismaClient;
  renderClipImpl?: typeof renderClip;
  captionOptions?: Omit<CaptionClipOptions, "prismaClient">;
  triggerTasteFeedbackSyncImpl?: TriggerTasteFeedbackSyncImpl;
  now?: Date;
  storage?: Pick<R2Storage, "presignSourceUrl">;
};

type TriggerTasteFeedbackSyncImpl = (
  creatorId: string,
  options?: TriggerTasteFeedbackSyncOptions,
) => Promise<TriggerTasteFeedbackSyncResult>;

export async function handleGetClip(
  request: Request,
  params: RouteParams,
  options: ReviewApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  const clip = await loadReviewClip(session.creatorId, await clipId(params), options);
  if (!clip) {
    return json({ error: "Clip not found." }, 404);
  }

  return json(serializeClip(clip), 200);
}

export async function handleGetClipPreview(
  request: Request,
  params: RouteParams,
  options: ReviewApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  const preview = await loadClipPreview(
    session.creatorId,
    await clipId(params),
    options,
  );
  if (!preview) {
    return json({ error: "Preview not found." }, 404);
  }

  return json(preview, 200);
}

export async function handleAcceptClip(
  request: Request,
  params: RouteParams,
  options: ReviewApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  try {
    const result = await acceptClipForReview(
      session.creatorId,
      await clipId(params),
      options,
    );
    if (!result) {
      return json({ error: "Clip not found." }, 404);
    }

    if (!result.clip.postCopyVariants) {
      const captionResult = await captionClip(result.clip.id, {
        ...options.captionOptions,
        prismaClient: options.prismaClient,
      });
      if (captionResult.status !== "captioned") {
        return json(
          {
            error: `Clip caption failed: ${captionResult.reason}.`,
          },
          502,
        );
      }
    }

    const schedulePass = await runSchedulePass(session.creatorId, new Date(), {
      prismaClient: options.prismaClient,
    });
    const scheduledClip = await loadClipAfterSchedulePass(
      session.creatorId,
      result.clip.id,
      options,
    );

    startRenderAfterAccept(
      result.clip.id,
      result.presetId,
      options.renderClipImpl,
      {
        prismaClient: options.prismaClient,
        onRenderComplete: () =>
          runSchedulePass(session.creatorId, new Date(), {
            prismaClient: options.prismaClient,
          }).then(() => undefined),
      },
    );
    startTasteFeedbackAfterVerdict(session.creatorId, options);

    return json(
      {
        clip: serializeClip(scheduledClip ?? result.clip),
        rendering: true,
        scheduledCount: schedulePass.scheduled.length,
      },
      200,
    );
  } catch (error) {
    return transitionErrorResponse(error);
  }
}

export async function handleRetryClipRender(
  request: Request,
  params: RouteParams,
  options: ReviewApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  try {
    const result = await retryRenderForReview(
      session.creatorId,
      await clipId(params),
      options,
    );
    if (!result) {
      return json({ error: "Clip not found." }, 404);
    }

    startRenderAfterAccept(
      result.clip.id,
      result.presetId,
      options.renderClipImpl,
      {
        prismaClient: options.prismaClient,
        onRenderComplete: () =>
          runSchedulePass(session.creatorId, new Date(), {
            prismaClient: options.prismaClient,
          }).then(() => undefined),
      },
    );

    return json(
      {
        clip: serializeClip(result.clip),
        rendering: true,
      },
      200,
    );
  } catch (error) {
    if (error instanceof RenderRetryStatusError) {
      return json({ error: error.message }, 409);
    }

    return transitionErrorResponse(error);
  }
}

async function loadClipAfterSchedulePass(
  creatorId: string,
  clipIdValue: string,
  options: ReviewApiOptions,
) {
  return loadReviewClip(creatorId, clipIdValue, options);
}

export async function handleRejectClip(
  request: Request,
  params: RouteParams,
  options: ReviewApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  try {
    const clip = await rejectClipForReview(
      session.creatorId,
      await clipId(params),
      options,
    );
    if (!clip) {
      return json({ error: "Clip not found." }, 404);
    }

    startTasteFeedbackAfterVerdict(session.creatorId, options);

    return json({ clip: serializeClip(clip) }, 200);
  } catch (error) {
    return transitionErrorResponse(error);
  }
}

export async function handleSetRejectReason(
  request: Request,
  params: RouteParams,
  options: ReviewApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Reject reason is required." }, 400);
  }

  const rejectReason = readRejectReason(payload);
  if (!rejectReason) {
    return json({ error: "Pick a valid reject reason." }, 400);
  }

  try {
    const clip = await setClipRejectReasonForReview(
      session.creatorId,
      await clipId(params),
      rejectReason,
      options,
    );
    if (!clip) {
      return json({ error: "Clip not found." }, 404);
    }

    return json({ clip: serializeClip(clip) }, 200);
  } catch (error) {
    if (error instanceof RejectReasonStatusError) {
      return json({ error: error.message }, 409);
    }

    throw error;
  }
}

export async function handleMarkClipPosted(
  request: Request,
  params: RouteParams,
  options: ReviewApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  try {
    const result = await markPostedForCreator(
      session.creatorId,
      await clipId(params),
      options.now ?? new Date(),
      {
        prismaClient: options.prismaClient,
      },
    );
    if (!result) {
      return json({ error: "Clip not found." }, 404);
    }
    const postedThisWeek = await countPostedThisWeek(
      session.creatorId,
      result.postedAt,
      {
        prismaClient: options.prismaClient,
      },
    );

    return json(
      {
        status: result.status,
        clipId: result.clipId,
        creatorId: result.creatorId,
        videoId: result.videoId,
        scheduledFor: result.scheduledFor?.toISOString() ?? null,
        postedAt: result.postedAt.toISOString(),
        postedThisWeek,
      },
      200,
    );
  } catch (error) {
    return transitionErrorResponse(error);
  }
}

async function loadCreatorSession(
  request: Request,
  options: ReviewApiOptions,
) {
  return loadCreatorSessionFromCookieHeader(
    request.headers.get("cookie"),
    options,
  );
}

async function clipId(params: RouteParams): Promise<string> {
  return (await params).id;
}

function transitionErrorResponse(error: unknown): Response {
  if (error instanceof ClipReadinessError) {
    return json({ error: error.message }, 409);
  }

  if (
    error instanceof Error &&
    error.message.startsWith("Invalid clip status transition")
  ) {
    return json({ error: error.message }, 409);
  }

  throw error;
}

function readRejectReason(payload: unknown) {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "rejectReason" in payload &&
    isRejectReason(payload.rejectReason)
  ) {
    return payload.rejectReason;
  }

  return null;
}

function startTasteFeedbackAfterVerdict(
  creatorId: string,
  options: ReviewApiOptions,
): void {
  const trigger =
    options.triggerTasteFeedbackSyncImpl ?? triggerTasteFeedbackSyncAfterVerdict;

  void trigger(creatorId, {
    prismaClient: options.prismaClient,
  }).catch((error: unknown) => {
    console.error(
      `Taste feedback trigger failed for creator ${creatorId}: ${errorMessage(error)}`,
    );
  });
}

function serializeClip(clip: {
  id: string;
  videoId: string;
  status: string;
  startMs: number;
  endMs: number;
  renderedUrl: string | null;
  renderFailedAt: Date | null;
  renderError: string | null;
  thumbUrl: string | null;
  postCopyVariants: unknown;
  scheduledFor: Date | null;
  transcript: string | null;
  mindRank: number | null;
  mindRankReason: string | null;
  rejectReason: string | null;
  createdAt: Date;
}) {
  return {
    id: clip.id,
    videoId: clip.videoId,
    status: clip.status,
    startMs: clip.startMs,
    endMs: clip.endMs,
    renderedUrl: clip.renderedUrl,
    renderFailedAt: clip.renderFailedAt?.toISOString() ?? null,
    renderError: clip.renderError,
    thumbUrl: clip.thumbUrl,
    postCopyVariants: clip.postCopyVariants,
    scheduledFor: clip.scheduledFor?.toISOString() ?? null,
    transcript: clip.transcript,
    mindRank: clip.mindRank,
    mindRankReason: clip.mindRankReason,
    rejectReason: clip.rejectReason,
    createdAt: clip.createdAt.toISOString(),
  };
}

function json(payload: unknown, status: number): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
