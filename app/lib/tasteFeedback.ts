import type { PrismaClient } from "@prisma/client";

import {
  MINDS_BUILDER_API_KEY_ENV,
  createMindsClientFromEnv,
  type MindsClient,
} from "./minds";
import { prisma } from "./db";
import {
  buildTasteFeedbackMessage,
  type TasteFeedbackPromptClip,
} from "./prompts/taste-feedback";

export const MAX_TASTE_FEEDBACK_BATCH = 10;
export const TASTE_FEEDBACK_TRIGGER_THRESHOLD = 3;

const VERDICT_STATUSES = ["accepted", "rejected", "scheduled", "posted"] as const;

export type TasteFeedbackVerdict = "accepted" | "rejected";

export type TasteFeedbackClip = {
  id: string;
  verdict: TasteFeedbackVerdict;
  startMs: number;
  endMs: number;
  transcript: string | null;
  mindRank: number | null;
  mindRankReason: string | null;
  rejectReason: string | null;
  createdAt: Date;
};

export type TasteFeedbackBatchRequest = {
  creatorExists: boolean;
  creatorMindId: string | null;
  alreadySyncedCount: number;
  clips: TasteFeedbackClip[];
};

export interface TasteFeedbackStore {
  loadFeedbackBatch(
    creatorId: string,
    limit: number,
  ): Promise<TasteFeedbackBatchRequest>;
  markFeedbackSynced(args: {
    creatorId: string;
    clipIds: readonly string[];
    syncedAt: Date;
  }): Promise<number>;
  countUnsyncedVerdictClips(creatorId: string): Promise<number>;
}

export type TasteFeedbackClock = {
  now(): Date;
};

export type TasteFeedbackLogger = Pick<Console, "error" | "log">;

export type SyncTasteFeedbackOptions = {
  mindsClient?: Pick<MindsClient, "sendMessageAndWaitForReply">;
  prismaClient?: PrismaClient;
  store?: TasteFeedbackStore;
  env?: NodeJS.ProcessEnv;
  clock?: TasteFeedbackClock;
  logger?: TasteFeedbackLogger;
};

export type SyncTasteFeedbackResult =
  | {
      status: "synced";
      creatorId: string;
      mindId: string;
      alias: string;
      clipIds: string[];
      acceptedCount: number;
      rejectedCount: number;
      syncedAt: Date;
      confirmation: string;
    }
  | {
      status: "empty";
      creatorId: string;
      reason: "no_unsynced_verdicts";
    }
  | {
      status: "skipped";
      creatorId: string;
      reason: "creator_not_found" | "no_mind" | "in_flight";
    };

export type SyncTasteFeedbackImpl = (
  creatorId: string,
  options?: SyncTasteFeedbackOptions,
) => Promise<SyncTasteFeedbackResult>;

export type TriggerTasteFeedbackSyncOptions = SyncTasteFeedbackOptions & {
  threshold?: number;
  runInBackground?: boolean;
  syncTasteFeedbackImpl?: SyncTasteFeedbackImpl;
};

export type TriggerTasteFeedbackSyncResult =
  | {
      status: "below_threshold";
      creatorId: string;
      unsyncedCount: number;
      threshold: number;
    }
  | {
      status: "in_flight";
      creatorId: string;
      unsyncedCount: number;
      threshold: number;
    }
  | {
      status: "queued";
      creatorId: string;
      unsyncedCount: number;
      threshold: number;
    }
  | {
      status: "completed";
      creatorId: string;
      unsyncedCount: number;
      threshold: number;
      result: SyncTasteFeedbackResult;
    };

const inFlightCreators = new Set<string>();

export async function syncTasteFeedback(
  creatorId: string,
  options: SyncTasteFeedbackOptions = {},
): Promise<SyncTasteFeedbackResult> {
  if (inFlightCreators.has(creatorId)) {
    return {
      status: "skipped",
      creatorId,
      reason: "in_flight",
    };
  }

  inFlightCreators.add(creatorId);
  try {
    return await syncTasteFeedbackOnce(creatorId, options);
  } finally {
    inFlightCreators.delete(creatorId);
  }
}

export async function triggerTasteFeedbackSyncAfterVerdict(
  creatorId: string,
  options: TriggerTasteFeedbackSyncOptions = {},
): Promise<TriggerTasteFeedbackSyncResult> {
  const threshold = options.threshold ?? TASTE_FEEDBACK_TRIGGER_THRESHOLD;
  const store =
    options.store ?? (await createPrismaTasteFeedbackStore(options.prismaClient));
  const unsyncedCount = await store.countUnsyncedVerdictClips(creatorId);

  if (unsyncedCount < threshold) {
    return {
      status: "below_threshold",
      creatorId,
      unsyncedCount,
      threshold,
    };
  }

  if (isTasteFeedbackSyncInFlight(creatorId)) {
    return {
      status: "in_flight",
      creatorId,
      unsyncedCount,
      threshold,
    };
  }

  const syncImpl = options.syncTasteFeedbackImpl ?? syncTasteFeedback;
  const syncOptions = syncOptionsFromTriggerOptions(options);

  if (options.runInBackground === false) {
    return {
      status: "completed",
      creatorId,
      unsyncedCount,
      threshold,
      result: await syncImpl(creatorId, syncOptions),
    };
  }

  void syncImpl(creatorId, syncOptions).catch((error: unknown) => {
    (options.logger ?? console).error(
      `Taste feedback sync failed for creator ${creatorId}: ${errorMessage(error)}`,
    );
  });

  return {
    status: "queued",
    creatorId,
    unsyncedCount,
    threshold,
  };
}

export function isTasteFeedbackSyncInFlight(creatorId: string): boolean {
  return inFlightCreators.has(creatorId);
}

export function buildTasteFeedbackConversationAlias(
  creatorId: string,
  alreadySyncedCount: number,
  now: Date,
): string {
  assertValidDate(now, "now");
  const shortCreatorId =
    creatorId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "creator";
  const stamp = compactTimestamp(now);
  const counter = String(Math.max(0, alreadySyncedCount) + 1).padStart(4, "0");

  return `clipmind-feedback-${shortCreatorId}-${stamp}-${counter}`.slice(0, 64);
}

async function syncTasteFeedbackOnce(
  creatorId: string,
  options: SyncTasteFeedbackOptions,
): Promise<SyncTasteFeedbackResult> {
  const store =
    options.store ?? (await createPrismaTasteFeedbackStore(options.prismaClient));
  const request = await store.loadFeedbackBatch(
    creatorId,
    MAX_TASTE_FEEDBACK_BATCH,
  );

  if (!request.creatorExists) {
    return {
      status: "skipped",
      creatorId,
      reason: "creator_not_found",
    };
  }

  const mindId = request.creatorMindId?.trim();
  if (!mindId) {
    return {
      status: "skipped",
      creatorId,
      reason: "no_mind",
    };
  }

  if (request.clips.length === 0) {
    return {
      status: "empty",
      creatorId,
      reason: "no_unsynced_verdicts",
    };
  }

  const mindsClient =
    options.mindsClient ?? createMindsClientFromEnv(options.env ?? process.env);
  if (!mindsClient) {
    throw new Error(
      `${MINDS_BUILDER_API_KEY_ENV} is required to sync taste feedback.`,
    );
  }

  const syncedAt = (options.clock ?? systemClock).now();
  assertValidDate(syncedAt, "syncedAt");
  const accepted = request.clips.filter((clip) => clip.verdict === "accepted");
  const rejected = request.clips.filter((clip) => clip.verdict === "rejected");
  const alias = buildTasteFeedbackConversationAlias(
    creatorId,
    request.alreadySyncedCount,
    syncedAt,
  );
  const confirmation = await mindsClient.sendMessageAndWaitForReply({
    mindId,
    alias,
    messageText: buildTasteFeedbackMessage({
      accepted: accepted.map(toPromptClip),
      rejected: rejected.map(toPromptClip),
    }),
    action: "Taste feedback sync",
  });

  const clipIds = request.clips.map((clip) => clip.id);
  await store.markFeedbackSynced({
    creatorId,
    clipIds,
    syncedAt,
  });

  (options.logger ?? console).log(
    [
      "Taste feedback synced",
      `creatorId=${creatorId}`,
      `mindId=${mindId}`,
      `clipCount=${clipIds.length}`,
      `accepted=${accepted.length}`,
      `rejected=${rejected.length}`,
      `clipIds=${clipIds.join(",")}`,
    ].join(" "),
  );

  return {
    status: "synced",
    creatorId,
    mindId,
    alias,
    clipIds,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    syncedAt,
    confirmation,
  };
}

function syncOptionsFromTriggerOptions(
  options: TriggerTasteFeedbackSyncOptions,
): SyncTasteFeedbackOptions {
  return {
    mindsClient: options.mindsClient,
    prismaClient: options.prismaClient,
    store: options.store,
    env: options.env,
    clock: options.clock,
    logger: options.logger,
  };
}

function toPromptClip(clip: TasteFeedbackClip): TasteFeedbackPromptClip {
  return {
    transcriptSnippet: clip.transcript,
    durationMs: clip.endMs - clip.startMs,
    mindRank: clip.mindRank,
    mindRankReason: clip.mindRankReason,
    rejectReason: clip.rejectReason,
  };
}

async function createPrismaTasteFeedbackStore(
  prismaClient?: PrismaClient,
): Promise<TasteFeedbackStore> {
  if (prismaClient) {
    return new PrismaTasteFeedbackStore(prismaClient);
  }

  return new PrismaTasteFeedbackStore(prisma);
}

class PrismaTasteFeedbackStore implements TasteFeedbackStore {
  constructor(private readonly db: PrismaClient) {}

  async loadFeedbackBatch(
    creatorId: string,
    limit: number,
  ): Promise<TasteFeedbackBatchRequest> {
    const creator = await this.db.creator.findUnique({
      where: {
        id: creatorId,
      },
      select: {
        mindId: true,
      },
    });

    if (!creator) {
      return {
        creatorExists: false,
        creatorMindId: null,
        alreadySyncedCount: 0,
        clips: [],
      };
    }

    const [alreadySyncedCount, clips] = await Promise.all([
      this.db.clip.count({
        where: {
          creatorId,
          feedbackSyncedAt: {
            not: null,
          },
        },
      }),
      this.db.clip.findMany({
        where: {
          creatorId,
          feedbackSyncedAt: null,
          status: {
            in: [...VERDICT_STATUSES],
          },
        },
        orderBy: [
          {
            createdAt: "asc",
          },
          {
            id: "asc",
          },
        ],
        take: limit,
        select: {
          id: true,
          status: true,
          startMs: true,
          endMs: true,
          transcript: true,
          mindRank: true,
          mindRankReason: true,
          rejectReason: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      creatorExists: true,
      creatorMindId: creator.mindId,
      alreadySyncedCount,
      clips: clips.map((clip) => ({
        id: clip.id,
        verdict: verdictFromStatus(clip.status),
        startMs: clip.startMs,
        endMs: clip.endMs,
        transcript: clip.transcript,
        mindRank: clip.mindRank,
        mindRankReason: clip.mindRankReason,
        rejectReason: clip.rejectReason,
        createdAt: clip.createdAt,
      })),
    };
  }

  async markFeedbackSynced(args: {
    creatorId: string;
    clipIds: readonly string[];
    syncedAt: Date;
  }): Promise<number> {
    const clipIds = [...new Set(args.clipIds)];
    if (clipIds.length === 0) {
      return 0;
    }

    return this.db.$transaction(async (tx) => {
      const selectedCount = await tx.clip.count({
        where: {
          creatorId: args.creatorId,
          id: {
            in: clipIds,
          },
          feedbackSyncedAt: null,
        },
      });

      if (selectedCount !== clipIds.length) {
        throw new Error(
          `Taste feedback sync expected ${clipIds.length} unsynced clips but found ${selectedCount}.`,
        );
      }

      const update = await tx.clip.updateMany({
        where: {
          creatorId: args.creatorId,
          id: {
            in: clipIds,
          },
          feedbackSyncedAt: null,
        },
        data: {
          feedbackSyncedAt: args.syncedAt,
        },
      });

      return update.count;
    });
  }

  async countUnsyncedVerdictClips(creatorId: string): Promise<number> {
    return this.db.clip.count({
      where: {
        creatorId,
        feedbackSyncedAt: null,
        status: {
          in: [...VERDICT_STATUSES],
        },
      },
    });
  }
}

function verdictFromStatus(status: string): TasteFeedbackVerdict {
  if (status === "rejected") {
    return "rejected";
  }
  if (status === "accepted" || status === "scheduled" || status === "posted") {
    return "accepted";
  }

  throw new Error(`Clip status ${status} is not a feedback verdict.`);
}

function compactTimestamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}${iso
    .slice(11, 19)
    .replace(/:/g, "")}`;
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const systemClock: TasteFeedbackClock = {
  now() {
    return new Date();
  },
};
