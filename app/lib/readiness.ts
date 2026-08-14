import type { Prisma } from "@prisma/client";

import type { PostCopyVariants } from "./captioning";

const REVIEW_READY_PIPELINE_STAGES = ["captions", "done", "failed"] as const;
const POST_COPY_PLATFORMS = ["youtube", "tiktok", "instagram"] as const;

export type ClipReadinessKind = "review" | "post";

export class ClipReadinessError extends Error {
  constructor(readiness: ClipReadinessKind) {
    super(
      readiness === "review"
        ? "Clip is not ready for review. Wait for Mind ranking to finish."
        : "Clip is not ready to post. Rendered media and all platform captions must be ready first.",
    );
    this.name = "ClipReadinessError";
  }
}

export function readyToReviewClipWhere(): Prisma.ClipWhereInput {
  return {
    mindRank: {
      not: null,
    },
    video: {
      pipelineStage: {
        in: [...REVIEW_READY_PIPELINE_STAGES],
      },
    },
  };
}

export function readyToPostClipWhere(): Prisma.ClipWhereInput {
  return {
    AND: [
      {
        renderedUrl: {
          not: null,
        },
      },
      ...POST_COPY_PLATFORMS.flatMap((platform) => [
        {
          postCopyVariants: {
            path: [platform],
            string_contains: "",
          },
        },
        {
          NOT: {
            postCopyVariants: {
              path: [platform],
              equals: "",
            },
          },
        },
      ]),
    ],
  };
}

export function assertClipReadyToReview(clip: {
  mindRank: number | null;
  video: {
    pipelineStage: string | null;
  };
}): void {
  if (!isClipReadyToReview(clip)) {
    throw new ClipReadinessError("review");
  }
}

export function assertClipReadyToPost(clip: {
  renderedUrl: string | null;
  postCopyVariants: Prisma.JsonValue;
}): void {
  if (!isClipReadyToPost(clip)) {
    throw new ClipReadinessError("post");
  }
}

export function isClipReadyToReview(clip: {
  mindRank: number | null;
  video: {
    pipelineStage: string | null;
  };
}): boolean {
  return (
    clip.mindRank !== null &&
    REVIEW_READY_PIPELINE_STAGES.includes(
      clip.video.pipelineStage as (typeof REVIEW_READY_PIPELINE_STAGES)[number],
    )
  );
}

export function isClipReadyToPost(clip: {
  renderedUrl: string | null;
  postCopyVariants: Prisma.JsonValue;
}): boolean {
  return (
    Boolean(clip.renderedUrl) &&
    hasCompletePostCopyVariants(clip.postCopyVariants)
  );
}

export function hasCompletePostCopyVariants(
  value: Prisma.JsonValue,
): value is PostCopyVariants {
  if (!isRecord(value)) {
    return false;
  }

  return POST_COPY_PLATFORMS.every((platform) => {
    const copy = value[platform];
    return typeof copy === "string" && copy.trim().length > 0;
  });
}

function isRecord(
  value: Prisma.JsonValue,
): value is Record<string, Prisma.JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
