import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import {
  computeDueNudges,
  type DueNudge,
  type NudgeCreatorState,
} from "./nudges";
import { sendPushNudgeToCreator } from "./push";
import { readyToPostClipWhere } from "./readiness";
import { scheduleSettingsFromRow } from "./schedule-settings";

export type PushTickOptions = {
  prismaClient?: PushTickDbClient;
  sendPushNudgeToCreatorImpl?: typeof sendPushNudgeToCreator;
};

type PushTickDbClient = PrismaClient | Prisma.TransactionClient;

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
      try {
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

        if (sendResult.sent > 0) {
          await markNudgeSent(db, creator.id, nudge, now, sendResult);
        } else {
          await markNudgeFailed(
            db,
            creator.id,
            nudge,
            now,
            summarizeSendFailures(sendResult),
          );
        }
      } catch (error) {
        result.failures += 1;
        await markNudgeFailed(
          db,
          creator.id,
          nudge,
          now,
          shortErrorMessage(error),
        ).catch((markError: unknown) => {
          console.error(
            `Push nudge failure state update failed for ${creator.id}/${nudge.kind}/${nudge.dedupeKey}: ${shortErrorMessage(markError)}`,
          );
        });
        console.error(
          `Push nudge failed for ${creator.id}/${nudge.kind}/${nudge.dedupeKey}: ${shortErrorMessage(error)}`,
        );
      }
    }
  }

  return result;
}

async function loadPushNudgeCreatorStates(
  db: PushTickDbClient,
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
              pipelineStage: {
                in: ["done", "failed"],
              },
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
      timezone: true,
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
      const [
        reviewCount,
        queuedClipCount,
        scheduledClips,
        failedVideos,
        doneVideos,
      ] = await Promise.all([
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
            AND: [readyToPostClipWhere()],
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
            pipelineRetryGeneration: true,
          },
        }),
        db.video.findMany({
          where: {
            creatorId: creator.id,
            pipelineStage: "done",
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
          },
        }),
      ]);

      return {
        id: creator.id,
        timezone: creator.timezone,
        reviewCount,
        queuedClipCount,
        schedule: scheduleSettingsFromRow(creator.schedule),
        scheduledClips,
        failedVideos,
        doneVideos,
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
  db: PushTickDbClient,
  creatorId: string,
  nudge: DueNudge,
  now: Date,
): Promise<boolean> {
  // The whole tick runs inside one transaction holding the advisory xact
  // lock, so ticks are globally serialized and this read-then-branch cannot
  // race. It must NOT rely on catching a unique-constraint violation: any SQL
  // error aborts the surrounding Postgres transaction and poisons every later
  // query in the tick.
  const existing = await db.nudgeLog.findUnique({
    where: {
      creatorId_kind_dedupeKey: {
        creatorId,
        kind: nudge.kind,
        dedupeKey: nudge.dedupeKey,
      },
    },
    select: { status: true },
  });

  if (existing === null) {
    await db.nudgeLog.create({
      data: {
        creatorId,
        kind: nudge.kind,
        dedupeKey: nudge.dedupeKey,
        status: "reserved",
        reservedAt: now,
        sentAt: null,
        lastFailureAt: null,
        lastFailure: null,
      },
    });
    return true;
  }

  if (existing.status === "failed") {
    const reclaimed = await db.nudgeLog.updateMany({
      where: {
        creatorId,
        kind: nudge.kind,
        dedupeKey: nudge.dedupeKey,
        status: "failed",
      },
      data: {
        status: "reserved",
        reservedAt: now,
        sentAt: null,
        lastFailureAt: null,
        lastFailure: null,
      },
    });
    return reclaimed.count === 1;
  }

  return false;
}

async function markNudgeSent(
  db: PushTickDbClient,
  creatorId: string,
  nudge: DueNudge,
  now: Date,
  sendResult: Awaited<ReturnType<typeof sendPushNudgeToCreator>>,
): Promise<void> {
  const failureSummary =
    sendResult.failures.length > 0 ? summarizeSendFailures(sendResult) : null;
  await db.nudgeLog.update({
    where: {
      creatorId_kind_dedupeKey: {
        creatorId,
        kind: nudge.kind,
        dedupeKey: nudge.dedupeKey,
      },
    },
    data: {
      status: "sent",
      sentAt: now,
      lastFailureAt: failureSummary ? now : null,
      lastFailure: failureSummary,
    },
  });
}

async function markNudgeFailed(
  db: PushTickDbClient,
  creatorId: string,
  nudge: DueNudge,
  now: Date,
  reason: string,
): Promise<void> {
  await db.nudgeLog.updateMany({
    where: {
      creatorId,
      kind: nudge.kind,
      dedupeKey: nudge.dedupeKey,
      status: "reserved",
    },
    data: {
      status: "failed",
      sentAt: null,
      lastFailureAt: now,
      lastFailure: reason,
    },
  });
}

function summarizeSendFailures(
  sendResult: Awaited<ReturnType<typeof sendPushNudgeToCreator>>,
): string {
  if (sendResult.failures.length === 0) {
    return sendResult.attempted === 0
      ? "No active push subscriptions."
      : "No push notifications were delivered.";
  }

  return sendResult.failures
    .slice(0, 3)
    .map((failure) =>
      failure.errorCode
        ? `${failure.status}:${failure.errorCode}`
        : String(failure.status),
    )
    .join(", ")
    .slice(0, 280);
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date.`);
  }
}

function shortErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message || "Unknown error.").replace(/\s+/g, " ").slice(0, 280);
}
