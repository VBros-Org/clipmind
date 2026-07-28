import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import {
  computeRunway,
  selectHomeNudges,
  type HomeNudge,
  type RunwayState,
} from "./home-rules";
import { SCHEDULE_ANCHOR_HOUR_UTC } from "./scheduling";
import { formatVideoLabel } from "./video-label";

export type { HomeNudge, RunwayState } from "./home-rules";

export type AppFrameData = {
  reviewCount: number;
};

export type HomeOverview = {
  runway: RunwayState;
  reviewCount: number;
  nextUp: NextScheduledClip | null;
  nudges: HomeNudge[];
  stats: {
    totalPosted: number;
    totalClipsMade: number;
  };
};

export type NextScheduledClip = {
  id: string;
  videoId: string;
  renderedUrl: string | null;
  scheduledForIso: string;
  hasCaptions: boolean;
  label: string;
};

export type RecentUpload = {
  id: string;
  label: string;
  status: string;
  pipelineStage: string;
  pipelineError: string | null;
  createdAtIso: string;
  clipCount: number;
};

export type RhythmOverview = {
  schedule:
    | {
        slotsPerDay: number;
        firstHourUtc: number;
      }
    | null;
  creator: {
    channelUrl: string | null;
    captionPreset: string;
  };
};

type AppOverviewOptions = {
  prismaClient?: PrismaClient;
  now?: Date;
};

export async function loadAppFrameData(
  creatorId: string,
  options: AppOverviewOptions = {},
): Promise<AppFrameData> {
  const db = options.prismaClient ?? prisma;
  const reviewCount = await db.clip.count({
    where: {
      creatorId,
      status: "candidate",
    },
  });

  return {
    reviewCount,
  };
}

export async function loadHomeOverview(
  creatorId: string,
  options: AppOverviewOptions = {},
): Promise<HomeOverview> {
  const db = options.prismaClient ?? prisma;
  const now = options.now ?? new Date();
  assertValidDate(now, "now");

  const [
    schedule,
    queuedClipCount,
    reviewCount,
    totalPosted,
    totalClipsMade,
    nextScheduledClip,
  ] = await Promise.all([
    db.schedule.findUnique({
      where: {
        creatorId,
      },
      select: {
        slotsPerDay: true,
      },
    }),
    db.clip.count({
      where: {
        creatorId,
        status: {
          in: ["accepted", "scheduled"],
        },
        postedAt: null,
      },
    }),
    db.clip.count({
      where: {
        creatorId,
        status: "candidate",
      },
    }),
    db.clip.count({
      where: {
        creatorId,
        status: "posted",
      },
    }),
    db.clip.count({
      where: {
        creatorId,
      },
    }),
    db.clip.findFirst({
      where: {
        creatorId,
        status: "scheduled",
        postedAt: null,
        scheduledFor: {
          not: null,
        },
      },
      orderBy: [
        {
          scheduledFor: "asc",
        },
        {
          id: "asc",
        },
      ],
      select: {
        id: true,
        videoId: true,
        renderedUrl: true,
        postCopyVariants: true,
        scheduledFor: true,
        video: {
          select: {
            createdAt: true,
          },
        },
      },
    }),
  ]);

  const runway = computeRunway(queuedClipCount, schedule);
  const nextUp = nextScheduledClip?.scheduledFor
    ? toNextScheduledClip(nextScheduledClip)
    : null;
  const nudges = selectHomeNudges({
    reviewCount,
    runway,
    dueClip:
      nextScheduledClip?.scheduledFor && nextScheduledClip.scheduledFor <= now
        ? {
            clipId: nextScheduledClip.id,
            timeLabel: formatHourMinute(nextScheduledClip.scheduledFor),
            isDue: true,
          }
        : null,
  });

  return {
    runway,
    reviewCount,
    nextUp,
    nudges,
    stats: {
      totalPosted,
      totalClipsMade,
    },
  };
}

export async function loadRecentUploads(
  creatorId: string,
  options: AppOverviewOptions = {},
): Promise<RecentUpload[]> {
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
    take: 3,
    select: {
      id: true,
      status: true,
      pipelineStage: true,
      pipelineError: true,
      createdAt: true,
      clips: {
        select: {
          id: true,
        },
      },
    },
  });

  return videos.map((video) => ({
    id: video.id,
    label: formatVideoLabel(video.createdAt),
    status: displayPipelineStage(video.pipelineStage, video.status),
    pipelineStage: displayPipelineStage(video.pipelineStage, video.status),
    pipelineError: video.pipelineError,
    createdAtIso: video.createdAt.toISOString(),
    clipCount: video.clips.length,
  }));
}

export async function loadRhythmOverview(
  creatorId: string,
  options: AppOverviewOptions = {},
): Promise<RhythmOverview> {
  const db = options.prismaClient ?? prisma;
  const creator = await db.creator.findUniqueOrThrow({
    where: {
      id: creatorId,
    },
    select: {
      channelUrl: true,
      captionStyle: true,
      schedule: {
        select: {
          slotsPerDay: true,
          slots: true,
        },
      },
    },
  });

  return {
    schedule: creator.schedule
      ? {
          slotsPerDay: creator.schedule.slotsPerDay,
          firstHourUtc: firstHourFromSlots(creator.schedule.slots),
        }
      : null,
    creator: {
      channelUrl: creator.channelUrl,
      captionPreset: captionPresetFromStyle(creator.captionStyle),
    },
  };
}

function toNextScheduledClip(clip: {
  id: string;
  videoId: string;
  renderedUrl: string | null;
  postCopyVariants: Prisma.JsonValue;
  scheduledFor: Date | null;
  video: {
    createdAt: Date;
  };
}): NextScheduledClip {
  return {
    id: clip.id,
    videoId: clip.videoId,
    renderedUrl: clip.renderedUrl,
    scheduledForIso: clip.scheduledFor?.toISOString() ?? "",
    hasCaptions: hasPostCopyVariants(clip.postCopyVariants),
    label: formatVideoLabel(clip.video.createdAt),
  };
}

function hasPostCopyVariants(value: Prisma.JsonValue): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.youtube === "string" &&
    typeof value.tiktok === "string" &&
    typeof value.instagram === "string"
  );
}

function firstHourFromSlots(value: Prisma.JsonValue): number {
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === "string") {
      const hourMatch = /^(\d{1,2}):/.exec(first);
      if (hourMatch) {
        return clampHour(Number(hourMatch[1]));
      }
    }

    if (isRecord(first) && typeof first.hour === "number") {
      return clampHour(first.hour);
    }
  }

  return SCHEDULE_ANCHOR_HOUR_UTC;
}

function captionPresetFromStyle(value: Prisma.JsonValue): string {
  if (!isRecord(value) || typeof value.preset !== "string") {
    return "clean-bold";
  }

  return value.preset;
}

function clampHour(hour: number): number {
  if (!Number.isFinite(hour)) {
    return SCHEDULE_ANCHOR_HOUR_UTC;
  }

  return Math.min(23, Math.max(0, Math.trunc(hour)));
}

function formatHourMinute(date: Date): string {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function displayPipelineStage(
  pipelineStage: string | null,
  legacyStatus: string,
): string {
  if (pipelineStage) {
    return pipelineStage;
  }

  switch (legacyStatus) {
    case "clipped":
      return "done";
    case "transcribed":
      return "candidates";
    default:
      return "uploaded";
  }
}

function isRecord(value: Prisma.JsonValue): value is Record<string, Prisma.JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date.`);
  }
}
