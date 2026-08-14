import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import {
  ClipReadinessError,
  assertClipReadyToPost,
  readyToPostClipWhere,
} from "./readiness";
import {
  DEFAULT_SCHEDULE_SETTINGS,
  buildSlotLabels,
  scheduleSettingsFromRow,
  type ScheduleSettings,
} from "./schedule-settings";
import {
  assertClipStatusTransition,
  computeNextSlot,
  pickNextClip,
  toClipSchedulingStatus,
  type ClipSchedulingStatus,
  type SchedulingClip,
  type SchedulingHistoryClip,
} from "./scheduling";

type SchedulingRepositoryOptions = {
  prismaClient?: PrismaClient;
};

export type ScheduleTickResult =
  | {
      status: "scheduled";
      creatorId: string;
      clipId: string;
      videoId: string;
      scheduledFor: Date;
    }
  | {
      status: "empty";
      creatorId: string;
      reason: "no_accepted_clips";
    };

export type SchedulePassResult = {
  status: "done";
  creatorId: string;
  scheduled: Extract<ScheduleTickResult, { status: "scheduled" }>[];
};

export type MarkPostedResult = {
  status: "posted";
  clipId: string;
  creatorId: string;
  videoId: string;
  scheduledFor: Date | null;
  postedAt: Date;
};

export async function scheduleTick(
  creatorId: string,
  now: Date = new Date(),
  options: SchedulingRepositoryOptions = {},
): Promise<ScheduleTickResult> {
  assertValidDate(now, "now");

  const db = options.prismaClient ?? prisma;

  return db.$transaction(async (tx) => {
    const schedule = await tx.schedule.findUnique({
      where: {
        creatorId,
      },
      select: {
        slotsPerDay: true,
        anchorHour: true,
        slotTimes: true,
        lastScheduledAt: true,
        rotation: true,
        creator: {
          select: {
            timezone: true,
          },
        },
      },
    });

    if (!schedule) {
      throw new Error(`Creator ${creatorId} does not have a schedule.`);
    }

    const acceptedClips = await tx.clip.findMany({
      where: {
        creatorId,
        status: "accepted",
        AND: [readyToPostClipWhere()],
      },
      select: {
        id: true,
        videoId: true,
        startMs: true,
        endMs: true,
        status: true,
        createdAt: true,
      },
      orderBy: [
        {
          createdAt: "asc",
        },
        {
          id: "asc",
        },
      ],
    });

    const historyClips = await tx.clip.findMany({
      where: {
        creatorId,
        status: {
          in: ["scheduled", "posted"],
        },
      },
      select: {
        id: true,
        videoId: true,
        startMs: true,
        endMs: true,
        status: true,
        createdAt: true,
        scheduledFor: true,
        postedAt: true,
      },
    });

    const selectedClip = pickNextClip(
      acceptedClips.map(toSchedulingClip),
      historyClips.map(toSchedulingHistoryClip),
    );

    if (!selectedClip) {
      return {
        status: "empty",
        creatorId,
        reason: "no_accepted_clips",
      };
    }

    assertClipStatusTransition(selectedClip.status, "scheduled");

    const duplicate = await tx.clip.findFirst({
      where: {
        id: {
          not: selectedClip.id,
        },
        creatorId,
        videoId: selectedClip.videoId,
        startMs: selectedClip.startMs,
        endMs: selectedClip.endMs,
        status: {
          in: ["scheduled", "posted"],
        },
      },
      select: {
        id: true,
        status: true,
      },
    });

    if (duplicate) {
      throw new Error(
        `Clip ${selectedClip.id} duplicates already ${duplicate.status} clip ${duplicate.id}.`,
      );
    }

    const scheduledFor = computeNextSlot(
      schedule,
      now,
      schedule.creator.timezone,
    );
    const updateResult = await tx.clip.updateMany({
      where: {
        id: selectedClip.id,
        status: "accepted",
        AND: [readyToPostClipWhere()],
      },
      data: {
        status: "scheduled",
        scheduledFor,
      },
    });

    if (updateResult.count !== 1) {
      throw new ClipReadinessError("post");
    }

    await tx.schedule.update({
      where: {
        creatorId,
      },
      data: {
        lastScheduledAt: scheduledFor,
        rotation: buildRotationState(
          schedule.rotation,
          selectedClip,
          scheduledFor,
        ),
      },
    });

    return {
      status: "scheduled",
      creatorId,
      clipId: selectedClip.id,
      videoId: selectedClip.videoId,
      scheduledFor,
    };
  });
}

export async function runSchedulePass(
  creatorId: string,
  now: Date = new Date(),
  options: SchedulingRepositoryOptions = {},
): Promise<SchedulePassResult> {
  assertValidDate(now, "now");

  const db = options.prismaClient ?? prisma;
  await ensureScheduleForCreator(creatorId, options);

  const acceptedClipCount = await db.clip.count({
    where: {
      creatorId,
      status: "accepted",
      AND: [readyToPostClipWhere()],
    },
  });
  const scheduled: Extract<ScheduleTickResult, { status: "scheduled" }>[] = [];

  for (let index = 0; index < acceptedClipCount; index += 1) {
    const result = await scheduleTick(creatorId, now, options);
    if (result.status === "empty") {
      break;
    }

    scheduled.push(result);
  }

  return {
    status: "done",
    creatorId,
    scheduled,
  };
}

export async function ensureScheduleForCreator(
  creatorId: string,
  options: SchedulingRepositoryOptions = {},
): Promise<ScheduleSettings> {
  const db = options.prismaClient ?? prisma;
  const existing = await db.schedule.findUnique({
    where: {
      creatorId,
    },
    select: scheduleSettingsSelect,
  });
  if (existing) {
    const settings = scheduleSettingsFromRow(existing);
    if (!settings) {
      throw new Error(`Creator ${creatorId} has an invalid schedule.`);
    }
    return settings;
  }

  try {
    const created = await db.schedule.create({
      data: {
        creatorId,
        slots: buildSlotLabels(DEFAULT_SCHEDULE_SETTINGS),
        rotation: {},
        ...scheduleSettingsWriteData(DEFAULT_SCHEDULE_SETTINGS),
      },
      select: scheduleSettingsSelect,
    });
    const settings = scheduleSettingsFromRow(created);
    if (!settings) {
      throw new Error(`Creator ${creatorId} has an invalid schedule.`);
    }
    return settings;
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const createdByRace = await db.schedule.findUniqueOrThrow({
      where: {
        creatorId,
      },
      select: scheduleSettingsSelect,
    });
    const settings = scheduleSettingsFromRow(createdByRace);
    if (!settings) {
      throw new Error(`Creator ${creatorId} has an invalid schedule.`);
    }
    return settings;
  }
}

export async function markPosted(
  clipId: string,
  now: Date = new Date(),
  options: SchedulingRepositoryOptions = {},
): Promise<MarkPostedResult> {
  assertValidDate(now, "now");

  const db = options.prismaClient ?? prisma;

  return db.$transaction(async (tx) => {
    const clip = await tx.clip.findUnique({
      where: {
        id: clipId,
      },
      select: {
        id: true,
        creatorId: true,
        videoId: true,
        status: true,
        scheduledFor: true,
        renderedUrl: true,
        postCopyVariants: true,
      },
    });

    if (!clip) {
      throw new Error(`Clip ${clipId} does not exist.`);
    }

    const fromStatus = toClipSchedulingStatus(clip.status);
    assertClipStatusTransition(fromStatus, "posted");
    assertClipReadyToPost(clip);

    const updateResult = await tx.clip.updateMany({
      where: {
        id: clip.id,
        status: "scheduled",
        AND: [readyToPostClipWhere()],
      },
      data: {
        status: "posted",
        postedAt: now,
      },
    });

    if (updateResult.count !== 1) {
      throw new ClipReadinessError("post");
    }

    return {
      status: "posted",
      clipId: clip.id,
      creatorId: clip.creatorId,
      videoId: clip.videoId,
      scheduledFor: clip.scheduledFor,
      postedAt: now,
    };
  });
}

export async function markPostedForCreator(
  creatorId: string,
  clipId: string,
  now: Date = new Date(),
  options: SchedulingRepositoryOptions = {},
): Promise<MarkPostedResult | null> {
  assertValidDate(now, "now");

  const db = options.prismaClient ?? prisma;

  return db.$transaction(async (tx) => {
    const clip = await tx.clip.findFirst({
      where: {
        id: clipId,
        creatorId,
      },
      select: {
        id: true,
        creatorId: true,
        videoId: true,
        status: true,
        scheduledFor: true,
        renderedUrl: true,
        postCopyVariants: true,
      },
    });

    if (!clip) {
      return null;
    }

    const fromStatus = toClipSchedulingStatus(clip.status);
    assertClipStatusTransition(fromStatus, "posted");
    assertClipReadyToPost(clip);

    const updateResult = await tx.clip.updateMany({
      where: {
        id: clip.id,
        creatorId,
        status: "scheduled",
        AND: [readyToPostClipWhere()],
      },
      data: {
        status: "posted",
        postedAt: now,
      },
    });

    if (updateResult.count !== 1) {
      throw new ClipReadinessError("post");
    }

    return {
      status: "posted",
      clipId: clip.id,
      creatorId: clip.creatorId,
      videoId: clip.videoId,
      scheduledFor: clip.scheduledFor,
      postedAt: now,
    };
  });
}

function toSchedulingClip(clip: {
  id: string;
  videoId: string;
  startMs: number;
  endMs: number;
  status: string;
  createdAt: Date;
}): SchedulingClip {
  return {
    id: clip.id,
    videoId: clip.videoId,
    startMs: clip.startMs,
    endMs: clip.endMs,
    status: toClipSchedulingStatus(clip.status),
    createdAt: clip.createdAt,
  };
}

function toSchedulingHistoryClip(clip: {
  id: string;
  videoId: string;
  startMs: number;
  endMs: number;
  status: string;
  createdAt: Date;
  scheduledFor: Date | null;
  postedAt: Date | null;
}): SchedulingHistoryClip {
  return {
    id: clip.id,
    videoId: clip.videoId,
    startMs: clip.startMs,
    endMs: clip.endMs,
    status: toClipSchedulingStatus(clip.status),
    createdAt: clip.createdAt,
    scheduledFor: clip.scheduledFor,
    postedAt: clip.postedAt,
  };
}

function buildRotationState(
  currentRotation: Prisma.JsonValue,
  clip: SchedulingClip,
  scheduledFor: Date,
): Prisma.InputJsonValue {
  const base = isJsonObject(currentRotation) ? currentRotation : {};

  return {
    ...base,
    lastScheduledClipId: clip.id,
    lastScheduledVideoId: clip.videoId,
    lastScheduledFor: scheduledFor.toISOString(),
  };
}

function isJsonObject(
  value: Prisma.JsonValue,
): value is Record<string, Prisma.JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const scheduleSettingsSelect = {
  slotsPerDay: true,
  anchorHour: true,
  slotTimes: true,
  reviewReminders: true,
  runwayWarnings: true,
  runwayThresholdDays: true,
  postTimeNudges: true,
  pushNudges: true,
} as const;

function scheduleSettingsWriteData(settings: ScheduleSettings) {
  return {
    slotsPerDay: settings.slotsPerDay,
    anchorHour: settings.anchorHour,
    slotTimes: settings.slotTimes ?? Prisma.DbNull,
    reviewReminders: settings.reviewReminders,
    runwayWarnings: settings.runwayWarnings,
    runwayThresholdDays: settings.runwayThresholdDays,
    postTimeNudges: settings.postTimeNudges,
    pushNudges: settings.pushNudges,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    !Array.isArray(error) &&
    "code" in error &&
    error.code === "P2002"
  );
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date.`);
  }
}
