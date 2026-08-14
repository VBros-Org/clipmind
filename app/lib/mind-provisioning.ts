import type { PrismaClient } from "@prisma/client";

import type { MindsClient } from "./minds";
import {
  DEFAULT_CREATOR_STEWARD_EMAIL,
  createCreatorMind,
} from "./onboarding";
import {
  WORKFLOW_LEASE_TTL_MS,
  isWorkflowLeaseExpired,
  withWorkflowHeartbeat,
} from "./workflow-lease";

const DEFAULT_ADOPTION_POLL_MS = 250;
const DEFAULT_ADOPTION_WAIT_MS = WORKFLOW_LEASE_TTL_MS + 5_000;

export type CreatorMindLeaseClaim =
  | {
      status: "claimed";
    }
  | {
      status: "adopted";
      mindId: string;
    };

export type CreatorMindLeaseOptions = {
  db: PrismaClient;
  creatorId: string;
  runId: string;
  workflowName: string;
  now?: Date;
  adoptionPollMs?: number;
  maxAdoptionWaitMs?: number;
  heartbeat?: () => Promise<void>;
  adoptReadyMindOnly?: boolean;
};

export type EnsureCreatorMindOptions = CreatorMindLeaseOptions & {
  mindsClient: MindsClient;
  stewardEmail?: string;
  heartbeatIntervalMs?: number;
  logger?: Pick<Console, "warn">;
};

export type EnsureCreatorMindResult = {
  mindId: string;
  mindEmail: string | null;
  created: boolean;
  adopted: boolean;
};

export async function claimCreatorMindLease(
  options: CreatorMindLeaseOptions,
): Promise<CreatorMindLeaseClaim> {
  const startedAt = Date.now();

  for (;;) {
    const creator = await options.db.creator.findUniqueOrThrow({
      where: {
        id: options.creatorId,
      },
      select: {
        mindId: true,
        mindStage: true,
      },
    });
    const mindId = creator.mindId?.trim() || null;
    if (mindId && canAdoptMind(creator.mindStage, options.adoptReadyMindOnly)) {
      return {
        status: "adopted",
        mindId,
      };
    }

    const now = currentNow(options.now);
    const claimed = await options.db.creator.updateMany({
      where: {
        id: options.creatorId,
        OR: [
          {
            mindRunId: null,
          },
          {
            mindRunId: options.runId,
          },
          {
            mindLeaseHeartbeatAt: null,
          },
          {
            mindLeaseHeartbeatAt: {
              lt: staleLeaseCutoff(now),
            },
          },
          {
            mindStage: "failed",
          },
        ],
      },
      data: {
        mindRunId: options.runId,
        mindLeaseHeartbeatAt: now,
      },
    });
    if (claimed.count === 1) {
      return {
        status: "claimed",
      };
    }

    await options.heartbeat?.();
    if (Date.now() - startedAt > adoptionWaitMs(options)) {
      throw new Error(
        `${options.workflowName} ${options.creatorId} timed out waiting for the creator Mind claim.`,
      );
    }
    await sleep(adoptionPollMs(options));
  }
}

export async function ensureCreatorMind(
  options: EnsureCreatorMindOptions,
): Promise<EnsureCreatorMindResult> {
  const claim = await claimCreatorMindLease(options);
  if (claim.status === "adopted") {
    return {
      mindId: claim.mindId,
      mindEmail: null,
      created: false,
      adopted: true,
    };
  }

  const existing = await options.db.creator.findUniqueOrThrow({
    where: {
      id: options.creatorId,
    },
    select: {
      mindId: true,
    },
  });
  const existingMindId = existing.mindId?.trim() || null;
  if (existingMindId) {
    return {
      mindId: existingMindId,
      mindEmail: null,
      created: false,
      adopted: true,
    };
  }

  const mind = await withWorkflowHeartbeat(
    () => heartbeatCreatorMindLease(options),
    () =>
      createCreatorMind({
        creatorId: options.creatorId,
        stewardEmail: options.stewardEmail ?? DEFAULT_CREATOR_STEWARD_EMAIL,
        mindsClient: options.mindsClient,
      }),
    options.heartbeatIntervalMs,
  );

  const stored = await options.db.creator.updateMany({
    where: {
      id: options.creatorId,
      mindId: null,
    },
    data: {
      mindId: mind.mindId,
      mindLeaseHeartbeatAt: currentNow(options.now),
    },
  });
  if (stored.count === 1) {
    return {
      mindId: mind.mindId,
      mindEmail: mind.mindEmail,
      created: true,
      adopted: false,
    };
  }

  const winner = await waitForCreatorMind(options);
  await disableOrphanMind(options, mind.mindId);
  return {
    mindId: winner,
    mindEmail: null,
    created: false,
    adopted: true,
  };
}

async function waitForCreatorMind(
  options: CreatorMindLeaseOptions,
): Promise<string> {
  const startedAt = Date.now();

  for (;;) {
    const creator = await options.db.creator.findUniqueOrThrow({
      where: {
        id: options.creatorId,
      },
      select: {
        mindId: true,
        mindLeaseHeartbeatAt: true,
      },
    });
    const mindId = creator.mindId?.trim() || null;
    if (mindId) {
      return mindId;
    }
    if (isWorkflowLeaseExpired(creator.mindLeaseHeartbeatAt, currentNow(options.now))) {
      throw new Error(
        `${options.workflowName} ${options.creatorId} lost the creator Mind claim before a winner was stored.`,
      );
    }
    if (Date.now() - startedAt > adoptionWaitMs(options)) {
      throw new Error(
        `${options.workflowName} ${options.creatorId} timed out waiting for the winning Mind.`,
      );
    }

    await options.heartbeat?.();
    await sleep(adoptionPollMs(options));
  }
}

async function heartbeatCreatorMindLease(
  options: CreatorMindLeaseOptions,
): Promise<void> {
  await options.heartbeat?.();
  const updated = await options.db.creator.updateMany({
    where: {
      id: options.creatorId,
      mindId: null,
      mindRunId: options.runId,
    },
    data: {
      mindLeaseHeartbeatAt: currentNow(options.now),
    },
  });
  if (updated.count !== 1) {
    throw new Error(
      `${options.workflowName} ${options.creatorId} lost the creator Mind claim.`,
    );
  }
}

async function disableOrphanMind(
  options: EnsureCreatorMindOptions,
  orphanMindId: string,
): Promise<void> {
  const logger = options.logger ?? console;
  if (!options.mindsClient.disableMind) {
    logger.warn(
      `${options.workflowName} ${options.creatorId} created orphan Mind ${orphanMindId}, but this Minds client cannot disable it.`,
    );
    return;
  }

  try {
    await options.mindsClient.disableMind(orphanMindId);
    logger.warn(
      `${options.workflowName} ${options.creatorId} disabled orphan Mind ${orphanMindId}.`,
    );
  } catch (error) {
    logger.warn(
      `${options.workflowName} ${options.creatorId} could not disable orphan Mind ${orphanMindId}: ${shortErrorMessage(error)}`,
    );
  }
}

function canAdoptMind(
  mindStage: string | null,
  adoptReadyMindOnly: boolean | undefined,
): boolean {
  return !adoptReadyMindOnly || mindStage === null || mindStage === "ready";
}

function staleLeaseCutoff(now: Date): Date {
  return new Date(now.getTime() - WORKFLOW_LEASE_TTL_MS);
}

function currentNow(now: Date | undefined): Date {
  const value = now ?? new Date();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("now must be a valid Date.");
  }

  return value;
}

function adoptionPollMs(options: CreatorMindLeaseOptions): number {
  return Math.max(1, options.adoptionPollMs ?? DEFAULT_ADOPTION_POLL_MS);
}

function adoptionWaitMs(options: CreatorMindLeaseOptions): number {
  return Math.max(1, options.maxAdoptionWaitMs ?? DEFAULT_ADOPTION_WAIT_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shortErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message || "Unknown error.").replace(/\s+/g, " ").slice(0, 280);
}
