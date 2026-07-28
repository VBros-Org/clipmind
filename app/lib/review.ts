import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import { renderClip } from "./render";
import {
  assertClipStatusTransition,
  toClipSchedulingStatus,
  type ClipSchedulingStatus,
} from "./scheduling";
import { createR2Storage, publicMediaUrlForKey, type R2Storage } from "./storage";
import type { PostCopyVariants } from "./captioning";

export const DEFAULT_CAPTION_PRESET = "clean-bold";

const REVIEW_STATUSES: ClipSchedulingStatus[] = [
  "candidate",
  "accepted",
  "rejected",
  "scheduled",
  "posted",
];

export type ReviewVideoSummary = {
  id: string;
  sourceUrl: string | null;
  sourceKey: string | null;
  status: string;
  createdAt: Date;
  counts: Record<ClipSchedulingStatus, number>;
  totalClips: number;
};

export type ReviewClip = {
  id: string;
  videoId: string;
  status: ClipSchedulingStatus;
  startMs: number;
  endMs: number;
  renderedUrl: string | null;
  thumbUrl: string | null;
  postCopyVariants: PostCopyVariants | null;
  transcript: string | null;
  mindRank: number | null;
  mindRankReason: string | null;
  createdAt: Date;
};

export type ReviewVideoDetail = {
  id: string;
  sourceUrl: string | null;
  sourceKey: string | null;
  status: string;
  createdAt: Date;
  previewSourceUrl: string | null;
  clips: ReviewClip[];
};

export type ReviewVideoGroup = {
  id: string;
  sourceUrl: string | null;
  sourceKey: string | null;
  status: string;
  createdAt: Date;
  counts: Record<ClipSchedulingStatus, number>;
  totalClips: number;
  clips: ReviewClip[];
};

export type ReviewClipApiPayload = ReviewClip & {
  previewSourceUrl?: string | null;
};

export type ReviewTransitionResult = {
  clip: ReviewClip;
  presetId: string;
};

type ReviewRepositoryOptions = {
  prismaClient?: PrismaClient;
  storage?: Pick<R2Storage, "presignSourceUrl">;
};

type RenderClipImpl = typeof renderClip;

export async function loadReviewVideos(
  creatorId: string,
  options: ReviewRepositoryOptions = {},
): Promise<ReviewVideoSummary[]> {
  const db = options.prismaClient ?? prisma;
  const videos = await db.video.findMany({
    where: {
      creatorId,
    },
    orderBy: [
      {
        createdAt: "desc",
      },
      {
        id: "asc",
      },
    ],
    select: {
      id: true,
      sourceUrl: true,
      sourceKey: true,
      status: true,
      createdAt: true,
      clips: {
        select: {
          status: true,
        },
      },
    },
  });

  return videos.map((video) => {
    const counts = emptyStatusCounts();
    for (const clip of video.clips) {
      counts[toClipSchedulingStatus(clip.status)] += 1;
    }

    return {
      id: video.id,
      sourceUrl: video.sourceUrl,
      sourceKey: video.sourceKey,
      status: video.status,
      createdAt: video.createdAt,
      counts,
      totalClips: video.clips.length,
    };
  });
}

export async function loadReviewVideo(
  creatorId: string,
  videoId: string,
  options: ReviewRepositoryOptions = {},
): Promise<ReviewVideoDetail | null> {
  const db = options.prismaClient ?? prisma;
  const video = await db.video.findFirst({
    where: {
      id: videoId,
      creatorId,
    },
    select: {
      id: true,
      sourceUrl: true,
      sourceKey: true,
      status: true,
      createdAt: true,
      clips: {
        orderBy: [
          {
            createdAt: "asc",
          },
          {
            id: "asc",
          },
        ],
        select: {
          id: true,
          videoId: true,
          status: true,
          startMs: true,
          endMs: true,
          renderedUrl: true,
          thumbKey: true,
          postCopyVariants: true,
          transcript: true,
          mindRank: true,
          mindRankReason: true,
          createdAt: true,
        },
      },
    },
  });

  if (!video) {
    return null;
  }

  const previewSourceUrl = video.sourceKey
    ? await (options.storage ?? createR2Storage()).presignSourceUrl(
        video.sourceKey,
      )
    : null;

  return {
    id: video.id,
    sourceUrl: video.sourceUrl,
    sourceKey: video.sourceKey,
    status: video.status,
    createdAt: video.createdAt,
    previewSourceUrl,
    clips: video.clips.map(toReviewClip).sort(compareReviewClips),
  };
}

export async function loadReviewGroups(
  creatorId: string,
  options: ReviewRepositoryOptions = {},
): Promise<ReviewVideoGroup[]> {
  const db = options.prismaClient ?? prisma;
  const videos = await db.video.findMany({
    where: {
      creatorId,
    },
    orderBy: [
      {
        createdAt: "desc",
      },
      {
        id: "asc",
      },
    ],
    select: {
      id: true,
      sourceUrl: true,
      sourceKey: true,
      status: true,
      createdAt: true,
      clips: {
        select: reviewClipSelect,
      },
    },
  });

  return videos.map(toReviewVideoGroup);
}

export async function loadReviewGroup(
  creatorId: string,
  videoId: string,
  options: ReviewRepositoryOptions = {},
): Promise<ReviewVideoGroup | null> {
  const db = options.prismaClient ?? prisma;
  const video = await db.video.findFirst({
    where: {
      id: videoId,
      creatorId,
    },
    select: {
      id: true,
      sourceUrl: true,
      sourceKey: true,
      status: true,
      createdAt: true,
      clips: {
        select: reviewClipSelect,
      },
    },
  });

  return video ? toReviewVideoGroup(video) : null;
}

export async function loadReviewClip(
  creatorId: string,
  clipId: string,
  options: ReviewRepositoryOptions = {},
): Promise<ReviewClipApiPayload | null> {
  const db = options.prismaClient ?? prisma;
  const clip = await db.clip.findFirst({
    where: {
      id: clipId,
      creatorId,
    },
    select: {
      id: true,
      videoId: true,
      status: true,
      startMs: true,
      endMs: true,
      renderedUrl: true,
      thumbKey: true,
      postCopyVariants: true,
      transcript: true,
      mindRank: true,
      mindRankReason: true,
      createdAt: true,
    },
  });

  return clip ? toReviewClip(clip) : null;
}

export async function loadClipPreview(
  creatorId: string,
  clipId: string,
  options: ReviewRepositoryOptions = {},
): Promise<{
  clipId: string;
  videoId: string;
  previewUrl: string;
  startMs: number;
  endMs: number;
} | null> {
  const db = options.prismaClient ?? prisma;
  const clip = await db.clip.findFirst({
    where: {
      id: clipId,
      creatorId,
    },
    select: {
      id: true,
      videoId: true,
      startMs: true,
      endMs: true,
      video: {
        select: {
          sourceKey: true,
        },
      },
    },
  });

  if (!clip?.video.sourceKey) {
    return null;
  }

  const storage = options.storage ?? createR2Storage();
  return {
    clipId: clip.id,
    videoId: clip.videoId,
    previewUrl: await storage.presignSourceUrl(clip.video.sourceKey),
    startMs: clip.startMs,
    endMs: clip.endMs,
  };
}

export async function acceptClipForReview(
  creatorId: string,
  clipId: string,
  options: ReviewRepositoryOptions = {},
): Promise<ReviewTransitionResult | null> {
  const db = options.prismaClient ?? prisma;

  return db.$transaction(async (tx) => {
    const clip = await tx.clip.findFirst({
      where: {
        id: clipId,
        creatorId,
      },
      select: {
        id: true,
        status: true,
        creator: {
          select: {
            captionStyle: true,
          },
        },
      },
    });

    if (!clip) {
      return null;
    }

    const fromStatus = toClipSchedulingStatus(clip.status);
    assertClipStatusTransition(fromStatus, "accepted");

    const updateResult = await tx.clip.updateMany({
      where: {
        id: clip.id,
        creatorId,
        status: fromStatus,
      },
      data: {
        status: "accepted",
      },
    });

    if (updateResult.count !== 1) {
      throw new Error(`Clip ${clip.id} was not ${fromStatus} at update time.`);
    }

    await tx.learningEvent.create({
      data: {
        clipId: clip.id,
        creatorId,
        action: "accept",
      },
    });

    const updated = await tx.clip.findUniqueOrThrow({
      where: {
        id: clip.id,
      },
      select: reviewClipSelect,
    });

    return {
      clip: toReviewClip(updated),
      presetId: captionPresetFromStyle(clip.creator.captionStyle),
    };
  });
}

export async function rejectClipForReview(
  creatorId: string,
  clipId: string,
  options: ReviewRepositoryOptions = {},
): Promise<ReviewClip | null> {
  const db = options.prismaClient ?? prisma;

  return db.$transaction(async (tx) => {
    const clip = await tx.clip.findFirst({
      where: {
        id: clipId,
        creatorId,
      },
      select: {
        id: true,
        status: true,
      },
    });

    if (!clip) {
      return null;
    }

    const fromStatus = toClipSchedulingStatus(clip.status);
    assertClipStatusTransition(fromStatus, "rejected");

    const updateResult = await tx.clip.updateMany({
      where: {
        id: clip.id,
        creatorId,
        status: fromStatus,
      },
      data: {
        status: "rejected",
      },
    });

    if (updateResult.count !== 1) {
      throw new Error(`Clip ${clip.id} was not ${fromStatus} at update time.`);
    }

    await tx.learningEvent.create({
      data: {
        clipId: clip.id,
        creatorId,
        action: "reject",
      },
    });

    const updated = await tx.clip.findUniqueOrThrow({
      where: {
        id: clip.id,
      },
      select: reviewClipSelect,
    });

    return toReviewClip(updated);
  });
}

export function startRenderAfterAccept(
  clipId: string,
  presetId: string,
  renderClipImpl: RenderClipImpl = renderClip,
): void {
  void renderClipImpl(clipId, presetId).catch((error: unknown) => {
    console.error(
      `Review render failed for clip ${clipId}: ${errorMessage(error)}`,
    );
  });
}

function captionPresetFromStyle(style: Prisma.JsonValue): string {
  if (!isRecord(style)) {
    return DEFAULT_CAPTION_PRESET;
  }

  const preset = style.preset;
  return typeof preset === "string" && preset.trim()
    ? preset.trim()
    : DEFAULT_CAPTION_PRESET;
}

const reviewClipSelect = {
  id: true,
  videoId: true,
  status: true,
  startMs: true,
  endMs: true,
  renderedUrl: true,
  thumbKey: true,
  postCopyVariants: true,
  transcript: true,
  mindRank: true,
  mindRankReason: true,
  createdAt: true,
} satisfies Prisma.ClipSelect;

function toReviewClip(clip: {
  id: string;
  videoId: string;
  status: string;
  startMs: number;
  endMs: number;
  renderedUrl: string | null;
  thumbKey: string | null;
  postCopyVariants: Prisma.JsonValue;
  transcript: string | null;
  mindRank: number | null;
  mindRankReason: string | null;
  createdAt: Date;
}): ReviewClip {
  return {
    id: clip.id,
    videoId: clip.videoId,
    status: toClipSchedulingStatus(clip.status),
    startMs: clip.startMs,
    endMs: clip.endMs,
    renderedUrl: clip.renderedUrl,
    thumbUrl: publicMediaUrlForKey(clip.thumbKey),
    postCopyVariants: toPostCopyVariants(clip.postCopyVariants),
    transcript: clip.transcript,
    mindRank: clip.mindRank,
    mindRankReason: clip.mindRankReason,
    createdAt: clip.createdAt,
  };
}

function toPostCopyVariants(value: Prisma.JsonValue): PostCopyVariants | null {
  if (!isRecord(value)) {
    return null;
  }

  const youtube = value.youtube;
  const tiktok = value.tiktok;
  const instagram = value.instagram;
  if (
    typeof youtube !== "string" ||
    typeof tiktok !== "string" ||
    typeof instagram !== "string"
  ) {
    return null;
  }

  return {
    youtube,
    tiktok,
    instagram,
  };
}

function compareReviewClips(left: ReviewClip, right: ReviewClip): number {
  if (left.mindRank !== null && right.mindRank === null) {
    return -1;
  }
  if (left.mindRank === null && right.mindRank !== null) {
    return 1;
  }
  if (left.mindRank !== null && right.mindRank !== null) {
    const rankDiff = left.mindRank - right.mindRank;
    if (rankDiff !== 0) {
      return rankDiff;
    }
  }

  const createdDiff = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdDiff !== 0) {
    return createdDiff;
  }

  return left.id.localeCompare(right.id);
}

function toReviewVideoGroup(video: {
  id: string;
  sourceUrl: string | null;
  sourceKey: string | null;
  status: string;
  createdAt: Date;
  clips: Array<{
    id: string;
    videoId: string;
    status: string;
    startMs: number;
    endMs: number;
    renderedUrl: string | null;
    thumbKey: string | null;
    postCopyVariants: Prisma.JsonValue;
    transcript: string | null;
    mindRank: number | null;
    mindRankReason: string | null;
    createdAt: Date;
  }>;
}): ReviewVideoGroup {
  const clips = video.clips.map(toReviewClip).sort(compareReviewClips);
  const counts = emptyStatusCounts();
  for (const clip of clips) {
    counts[clip.status] += 1;
  }

  return {
    id: video.id,
    sourceUrl: video.sourceUrl,
    sourceKey: video.sourceKey,
    status: video.status,
    createdAt: video.createdAt,
    counts,
    totalClips: clips.length,
    clips,
  };
}

function emptyStatusCounts(): Record<ClipSchedulingStatus, number> {
  return Object.fromEntries(REVIEW_STATUSES.map((status) => [status, 0])) as Record<
    ClipSchedulingStatus,
    number
  >;
}

function isRecord(value: Prisma.JsonValue): value is Record<string, Prisma.JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
