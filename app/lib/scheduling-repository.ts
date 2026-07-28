import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "./db";
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

export type SchedulePassResult =
  | {
      status: "done";
      creatorId: string;
      scheduled: Extract<ScheduleTickResult, { status: "scheduled" }>[];
    }
  | {
      status: "no_schedule";
      creatorId: string;
      scheduled: [];
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
        lastScheduledAt: true,
        rotation: true,
      },
    });

    if (!schedule) {
      throw new Error(`Creator ${creatorId} does not have a schedule.`);
    }

    const acceptedClips = await tx.clip.findMany({
      where: {
        creatorId,
        status: "accepted",
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

    const scheduledFor = computeNextSlot(schedule, now);
    const updateResult = await tx.clip.updateMany({
      where: {
        id: selectedClip.id,
        status: "accepted",
      },
      data: {
        status: "scheduled",
        scheduledFor,
      },
    });

    if (updateResult.count !== 1) {
      throw new Error(`Clip ${selectedClip.id} was not accepted at update time.`);
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
  const schedule = await db.schedule.findUnique({
    where: {
      creatorId,
    },
    select: {
      id: true,
    },
  });

  if (!schedule) {
    return {
      status: "no_schedule",
      creatorId,
      scheduled: [],
    };
  }

  const acceptedClipCount = await db.clip.count({
    where: {
      creatorId,
      status: "accepted",
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
      },
    });

    if (!clip) {
      throw new Error(`Clip ${clipId} does not exist.`);
    }

    const fromStatus = toClipSchedulingStatus(clip.status);
    assertClipStatusTransition(fromStatus, "posted");

    const updateResult = await tx.clip.updateMany({
      where: {
        id: clip.id,
        status: "scheduled",
      },
      data: {
        status: "posted",
        postedAt: now,
      },
    });

    if (updateResult.count !== 1) {
      throw new Error(`Clip ${clip.id} was not scheduled at update time.`);
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

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date.`);
  }
}
