import type { PrismaClient } from "@prisma/client";

import { loadCreatorSessionFromCookieHeader } from "./review-auth";
import {
  acceptClipForReview,
  loadClipPreview,
  loadReviewClip,
  rejectClipForReview,
  startRenderAfterAccept,
} from "./review";
import type { renderClip } from "./render";
import type { R2Storage } from "./storage";

type RouteParams = { id: string } | Promise<{ id: string }>;

type ReviewApiOptions = {
  prismaClient?: PrismaClient;
  renderClipImpl?: typeof renderClip;
  storage?: Pick<R2Storage, "presignSourceUrl">;
};

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

    startRenderAfterAccept(
      result.clip.id,
      result.presetId,
      options.renderClipImpl,
    );

    return json(
      {
        clip: serializeClip(result.clip),
        rendering: true,
      },
      200,
    );
  } catch (error) {
    return transitionErrorResponse(error);
  }
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

    return json({ clip: serializeClip(clip) }, 200);
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
  if (
    error instanceof Error &&
    error.message.startsWith("Invalid clip status transition")
  ) {
    return json({ error: error.message }, 409);
  }

  throw error;
}

function serializeClip(clip: {
  id: string;
  videoId: string;
  status: string;
  startMs: number;
  endMs: number;
  renderedUrl: string | null;
  postCopyVariants: unknown;
  transcript: string | null;
  mindRank: number | null;
  mindRankReason: string | null;
  createdAt: Date;
}) {
  return {
    id: clip.id,
    videoId: clip.videoId,
    status: clip.status,
    startMs: clip.startMs,
    endMs: clip.endMs,
    renderedUrl: clip.renderedUrl,
    postCopyVariants: clip.postCopyVariants,
    transcript: clip.transcript,
    mindRank: clip.mindRank,
    mindRankReason: clip.mindRankReason,
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
