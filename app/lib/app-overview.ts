import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import {
  selectHomeUploadCards,
  type HomeUploadCard,
} from "./home-upload-cards";
import {
  computeDueNudges,
  computeRunway,
  toHomeNudges,
  type HomeNudge,
  type RunwayState,
} from "./nudges";
import { countPostedThisWeek } from "./posting-stats";
import {
  hasCompletePostCopyVariants,
  readyToPostClipWhere,
} from "./readiness";
import {
  scheduleSettingsFromRow,
  type ScheduleSettings,
} from "./schedule-settings";
import { ensureScheduleForCreator } from "./scheduling-repository";
import { resolveCreatorTimezone } from "./timezone";
import { publicMediaUrlForKey } from "./storage";
import { publicUploadWorkflowErrorMessage } from "./public-upload-errors";
import { formatVideoLabel } from "./video-label";
import { captionCorpusSummary } from "./caption-corpus";
import type { PostCopyVariants } from "./captioning";
import { canRetryPipelineStage } from "./pipeline";
import {
  canRetryMindOnboardingStage,
  creatorHasReadyMind,
  creatorNeedsMindOnboarding,
  failedMindOnboardingStage,
  isMindOnboardingStage,
} from "./video-onboarding";
import { workflowLeaseExpiredError } from "./workflow-lease";

export type { HomeNudge, RunwayState } from "./nudges";

export type AppFrameData = {
  pushNudgesEnabled: boolean;
  reviewCount: number;
};

export type HomeOverview = {
  runway: RunwayState;
  pushNudgesEnabled: boolean;
  reviewCount: number;
  nextUp: NextScheduledClip | null;
  readyToPost: ReadyToPostClip[];
  uploadCards: HomeUploadCard[];
  nudges: HomeNudge[];
  stats: {
    totalPosted: number;
    postedThisWeek: number;
    totalClipsMade: number;
  };
};

export type NextScheduledClip = {
  id: string;
  videoId: string;
  renderedUrl: string | null;
  thumbUrl: string | null;
  scheduledForIso: string;
  hasCaptions: boolean;
  label: string;
};

export type ReadyToPostClip = {
  id: string;
  videoId: string;
  renderedUrl: string | null;
  thumbUrl: string | null;
  scheduledForIso: string;
  postCopyVariants: PostCopyVariants | null;
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

export type UploadOverview = {
  needsMindCorpus: boolean;
  recentUploads: RecentUpload[];
};

export type RhythmOverview = {
  schedule: ScheduleSettings;
  creator: {
    displayName: string | null;
    channelUrl: string | null;
    captionPreset: string;
    captionCorpus: string;
    captionCount: number;
    channelPullStage: string | null;
    channelPullError: string | null;
    channelPullLeaseHeartbeatAt: Date | null;
    hasMind: boolean;
    timezone: string;
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
  const [reviewCount, schedule] = await Promise.all([
    db.clip.count({
      where: {
        creatorId,
        status: "candidate",
      },
    }),
    db.schedule.findUnique({
      where: {
        creatorId,
      },
      select: {
        pushNudges: true,
      },
    }),
  ]);

  return {
    pushNudgesEnabled: schedule?.pushNudges === true,
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
    postedThisWeek,
    creator,
    nextScheduledClip,
    readyToPostClips,
    activeUploadVideos,
  ] = await Promise.all([
    db.schedule.findUnique({
      where: {
        creatorId,
      },
      select: {
        slotsPerDay: true,
        anchorHour: true,
        slotTimes: true,
        reviewReminders: true,
        runwayWarnings: true,
        runwayThresholdDays: true,
        postTimeNudges: true,
        pushNudges: true,
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
    countPostedThisWeek(creatorId, now, {
      prismaClient: db,
    }),
    db.creator.findUniqueOrThrow({
      where: {
        id: creatorId,
      },
      select: {
        timezone: true,
        mindId: true,
        mindStage: true,
        mindError: true,
        mindLeaseHeartbeatAt: true,
      },
    }),
    db.clip.findFirst({
      where: {
        creatorId,
        status: "scheduled",
        postedAt: null,
        AND: [readyToPostClipWhere()],
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
        thumbKey: true,
        postCopyVariants: true,
        scheduledFor: true,
        video: {
          select: {
            createdAt: true,
          },
        },
      },
    }),
    db.clip.findMany({
      where: {
        creatorId,
        status: "scheduled",
        postedAt: null,
        AND: [readyToPostClipWhere()],
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
      take: 10,
      select: {
        id: true,
        videoId: true,
        renderedUrl: true,
        thumbKey: true,
        postCopyVariants: true,
        scheduledFor: true,
        video: {
          select: {
            createdAt: true,
          },
        },
      },
    }),
    db.video.findMany({
      where: {
        creatorId,
        pipelineStage: {
          not: null,
        },
        NOT: {
          pipelineStage: "done",
        },
      },
      orderBy: [
        {
          createdAt: "desc",
        },
        {
          id: "asc",
        },
      ],
      take: 10,
      select: {
        id: true,
        status: true,
        pipelineStage: true,
        pipelineError: true,
        pipelineLeaseHeartbeatAt: true,
        createdAt: true,
      },
    }),
  ]);

  const scheduleSettings = scheduleSettingsFromRow(schedule);
  const runway = computeRunway(queuedClipCount, scheduleSettings);
  const nextUp = nextScheduledClip?.scheduledFor
    ? toNextScheduledClip(nextScheduledClip)
    : null;
  const readyToPost = readyToPostClips
    .filter((clip) => clip.scheduledFor)
    .map(toReadyToPostClip);
  const uploadWorkflowVideos = activeUploadVideos.map((video) => {
    const displayStage = displayUploadStage({
      creator,
      pipelineStage: video.pipelineStage,
      pipelineError: video.pipelineError,
      pipelineLeaseHeartbeatAt: video.pipelineLeaseHeartbeatAt,
      status: video.status,
      now,
    });

    return {
      id: video.id,
      label: formatVideoLabel(video.createdAt),
      pipelineStage: displayStage.stage,
      pipelineError: displayStage.error,
    };
  });
  const uploadCards = selectHomeUploadCards(uploadWorkflowVideos);
  const nudges = toHomeNudges(
    computeDueNudges(
      {
        id: creatorId,
        timezone: creator.timezone,
        reviewCount,
        queuedClipCount,
        schedule: scheduleSettings,
        scheduledClips: readyToPost.map((clip) => ({
          id: clip.id,
          scheduledFor: new Date(clip.scheduledForIso),
          status: "scheduled",
        })),
        failedVideos: uploadWorkflowVideos,
      },
      now,
    ),
  );

  return {
    runway,
    pushNudgesEnabled: scheduleSettings?.pushNudges === true,
    reviewCount,
    nextUp,
    readyToPost,
    uploadCards,
    nudges,
    stats: {
      totalPosted,
      postedThisWeek,
      totalClipsMade,
    },
  };
}

export async function loadRecentUploads(
  creatorId: string,
  options: AppOverviewOptions = {},
): Promise<RecentUpload[]> {
  return (await loadUploadOverview(creatorId, options)).recentUploads;
}

export async function loadUploadOverview(
  creatorId: string,
  options: AppOverviewOptions = {},
): Promise<UploadOverview> {
  const db = options.prismaClient ?? prisma;
  const now = options.now ?? new Date();
  assertValidDate(now, "now");
  const [creator, videos] = await Promise.all([
    db.creator.findUniqueOrThrow({
      where: {
        id: creatorId,
      },
      select: {
        mindId: true,
        mindStage: true,
        mindError: true,
        mindLeaseHeartbeatAt: true,
      },
    }),
    db.video.findMany({
      where: {
        creatorId,
        NOT: {
          OR: [
            {
              pipelineStage: "done",
            },
            {
              pipelineStage: null,
              status: "clipped",
            },
          ],
        },
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
        status: true,
        pipelineStage: true,
        pipelineError: true,
        pipelineLeaseHeartbeatAt: true,
        createdAt: true,
        clips: {
          select: {
            id: true,
          },
        },
      },
    }),
  ]);

  const needsMindCorpus = creatorNeedsMindOnboarding(creator);

  return {
    needsMindCorpus,
    recentUploads: videos.map((video) => {
      const displayStage = displayUploadStage({
        creator,
        pipelineStage: video.pipelineStage,
        pipelineError: video.pipelineError,
        pipelineLeaseHeartbeatAt: video.pipelineLeaseHeartbeatAt,
        status: video.status,
        now,
      });

      return {
        id: video.id,
        label: formatVideoLabel(video.createdAt),
        status: displayStage.stage,
        pipelineStage: displayStage.stage,
        pipelineError: displayStage.error,
        createdAtIso: video.createdAt.toISOString(),
        clipCount: video.clips.length,
      };
    }),
  };
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
      displayName: true,
      channelUrl: true,
      captionStyle: true,
      captionCorpus: true,
      channelPullStage: true,
      channelPullError: true,
      channelPullLeaseHeartbeatAt: true,
      mindId: true,
      timezone: true,
    },
  });
  const schedule = await ensureScheduleForCreator(creatorId, {
    prismaClient: db,
  });
  const corpus = captionCorpusSummary(creator.captionCorpus);

  return {
    schedule,
    creator: {
      displayName: creator.displayName,
      channelUrl: creator.channelUrl,
      captionPreset: captionPresetFromStyle(creator.captionStyle),
      captionCorpus: corpus.captionCorpus,
      captionCount: corpus.captionCount,
      channelPullStage: creator.channelPullStage,
      channelPullError: creator.channelPullError,
      channelPullLeaseHeartbeatAt: creator.channelPullLeaseHeartbeatAt,
      hasMind: Boolean(creator.mindId?.trim()),
      timezone: resolveCreatorTimezone(creator.timezone),
    },
  };
}

function toNextScheduledClip(clip: {
  id: string;
  videoId: string;
  renderedUrl: string | null;
  thumbKey: string | null;
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
    thumbUrl: publicMediaUrlForKey(clip.thumbKey),
    scheduledForIso: clip.scheduledFor?.toISOString() ?? "",
    hasCaptions: hasPostCopyVariants(clip.postCopyVariants),
    label: formatVideoLabel(clip.video.createdAt),
  };
}

function toReadyToPostClip(clip: {
  id: string;
  videoId: string;
  renderedUrl: string | null;
  thumbKey: string | null;
  postCopyVariants: Prisma.JsonValue;
  scheduledFor: Date | null;
  video: {
    createdAt: Date;
  };
}): ReadyToPostClip {
  return {
    id: clip.id,
    videoId: clip.videoId,
    renderedUrl: clip.renderedUrl,
    thumbUrl: publicMediaUrlForKey(clip.thumbKey),
    scheduledForIso: clip.scheduledFor?.toISOString() ?? "",
    postCopyVariants: toPostCopyVariants(clip.postCopyVariants),
    label: formatVideoLabel(clip.video.createdAt),
  };
}

function hasPostCopyVariants(value: Prisma.JsonValue): boolean {
  return hasCompletePostCopyVariants(value);
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

function captionPresetFromStyle(value: Prisma.JsonValue): string {
  if (!isRecord(value) || typeof value.preset !== "string") {
    return "clean-bold";
  }

  return value.preset;
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

function displayUploadStage(args: {
  creator: {
    mindId: string | null;
    mindStage: string | null;
    mindError: string | null;
    mindLeaseHeartbeatAt: Date | null;
  };
  pipelineStage: string | null;
  pipelineError: string | null;
  pipelineLeaseHeartbeatAt: Date | null;
  status: string;
  now: Date;
}): {
  stage: string;
  error: string | null;
} {
  if (!creatorHasReadyMind(args.creator)) {
    if (args.creator.mindStage === "failed") {
      return {
        stage: "failed",
        error: publicUploadWorkflowErrorMessage(
          args.creator.mindError,
          failedMindOnboardingStage(args.creator.mindError),
        ),
      };
    }
    if (isMindOnboardingStage(args.creator.mindStage)) {
      if (canRetryMindOnboardingStage(args.creator, args.now)) {
        return {
          stage: "failed",
          error: publicUploadWorkflowErrorMessage(
            workflowLeaseExpiredError(args.creator.mindStage),
            args.creator.mindStage,
          ),
        };
      }

      return {
        stage: args.creator.mindStage,
        error: null,
      };
    }

    return {
      stage: "learning_voice",
      error: null,
    };
  }

  const stage = displayPipelineStage(args.pipelineStage, args.status);
  if (
    stage !== "done" &&
    stage !== "failed" &&
    canRetryPipelineStage(
      {
        pipelineStage: stage,
        pipelineLeaseHeartbeatAt: args.pipelineLeaseHeartbeatAt,
      },
      args.now,
    )
  ) {
    return {
      stage: "failed",
      error: publicUploadWorkflowErrorMessage(
        workflowLeaseExpiredError(stage),
        stage,
      ),
    };
  }

  return {
    stage,
    error: args.pipelineError
      ? publicUploadWorkflowErrorMessage(args.pipelineError, stage)
      : null,
  };
}

function isRecord(value: Prisma.JsonValue): value is Record<string, Prisma.JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date.`);
  }
}
