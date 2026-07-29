import type { PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import {
  computeDueNudges,
  type DueNudge,
  type NudgeCreatorState,
} from "./nudges";
import { sendPushNudgeToCreator } from "./push";
import { scheduleSettingsFromRow } from "./schedule-settings";

type PushTickOptions = {
  prismaClient?: PrismaClient;
  sendPushNudgeToCreatorImpl?: typeof sendPushNudgeToCreator;
};

export type PushTickResult = {
  status: "done";
  creatorsChecked: number;
  nudgesDue: number;
  sent: number;
  skippedDuplicate: number;
  disabledSubscriptions: number;
  failures: number;
  messageIds: string[];
};

export async function runPushTick(
  now: Date = new Date(),
  options: PushTickOptions = {},
): Promise<PushTickResult> {
  assertValidDate(now, "now");

  const db = options.prismaClient ?? prisma;
  const sendPush =
    options.sendPushNudgeToCreatorImpl ?? sendPushNudgeToCreator;
  const creators = await loadPushNudgeCreatorStates(db, now);
  const result: PushTickResult = {
    status: "done",
    creatorsChecked: creators.length,
    nudgesDue: 0,
    sent: 0,
    skippedDuplicate: 0,
    disabledSubscriptions: 0,
    failures: 0,
    messageIds: [],
  };

  for (const creator of creators) {
    const dueNudges = pushEnabledNudges(
      computeDueNudges(creator, now),
      creator.schedule?.pushNudges === true,
    );
    result.nudgesDue += dueNudges.length;

    for (const nudge of dueNudges) {
      const reserved = await reserveNudge(db, creator.id, nudge, now);
      if (!reserved) {
        result.skippedDuplicate += 1;
        continue;
      }

      const sendResult = await sendPush(creator.id, nudge, {
        prismaClient: db,
        now,
      });
      result.sent += sendResult.sent;
      result.disabledSubscriptions += sendResult.disabled;
      result.failures += sendResult.failures.length;
      result.messageIds.push(...sendResult.messageIds);
    }
  }

  return result;
}

async function loadPushNudgeCreatorStates(
  db: PrismaClient,
  now: Date,
): Promise<NudgeCreatorState[]> {
  const creators = await db.creator.findMany({
    where: {
      OR: [
        {
          schedule: {
            pushNudges: true,
          },
        },
        {
          videos: {
            some: {
              pipelineStage: "failed",
            },
          },
        },
      ],
      pushSubscriptions: {
        some: {
          disabledAt: null,
        },
      },
    },
    orderBy: {
      createdAt: "asc",
    },
    select: {
      id: true,
      schedule: {
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
      },
    },
  });

  return Promise.all(
    creators.map(async (creator) => {
      const [reviewCount, queuedClipCount, scheduledClips, failedVideos] =
        await Promise.all([
        db.clip.count({
          where: {
            creatorId: creator.id,
            status: "candidate",
          },
        }),
        db.clip.count({
          where: {
            creatorId: creator.id,
            status: {
              in: ["accepted", "scheduled"],
            },
            postedAt: null,
          },
        }),
        db.clip.findMany({
          where: {
            creatorId: creator.id,
            status: "scheduled",
            postedAt: null,
            scheduledFor: {
              lte: now,
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
            status: true,
            scheduledFor: true,
            postedAt: true,
          },
        }),
        db.video.findMany({
          where: {
            creatorId: creator.id,
            pipelineStage: "failed",
          },
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
            pipelineStage: true,
            pipelineError: true,
          },
        }),
      ]);

      return {
        id: creator.id,
        reviewCount,
        queuedClipCount,
        schedule: scheduleSettingsFromRow(creator.schedule),
        scheduledClips,
        failedVideos,
      };
    }),
  );
}

function pushEnabledNudges(
  nudges: DueNudge[],
  pushNudges: boolean,
): DueNudge[] {
  if (pushNudges) {
    return nudges;
  }

  // Failed upload pushes bypass the schedule-level push toggle. Review, runway,
  // and post-time pushes are optional reminders; a failed pipeline is not.
  return nudges.filter((nudge) => nudge.kind === "failed");
}

async function reserveNudge(
  db: PrismaClient,
  creatorId: string,
  nudge: DueNudge,
  now: Date,
): Promise<boolean> {
  try {
    await db.nudgeLog.create({
      data: {
        creatorId,
        kind: nudge.kind,
        dedupeKey: nudge.dedupeKey,
        sentAt: now,
      },
    });
    return true;
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return false;
    }

    throw error;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date.`);
  }
}
