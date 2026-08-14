import type { Prisma, PrismaClient } from "@prisma/client";

import { createClipServiceTranscriber, clipServiceConfigFromEnv } from "./clip-service";
import { prisma } from "./db";
import {
  MINDS_BUILDER_API_KEY_ENV,
  createMindsClientFromEnv,
  type MindsClient,
} from "./minds";
import {
  DEFAULT_CREATOR_STEWARD_EMAIL,
  createCreatorMind,
  distillCorpusTenets,
  seedCreatorTenets,
  transcribeCorpusItems,
} from "./onboarding";
import { createOpenAITenetDistiller } from "./openai-distill";
import {
  CORPUS_WEIGHTS,
  type WeightedTranscript,
} from "./prompts/voice-distill";
import {
  runPipeline,
  type PipelineOptions,
  type PipelineRunResult,
} from "./pipeline";
import { createR2Storage, type R2Storage } from "./storage";
import { parseInitialTenets, type InitialTenets } from "./tenets";
import type { CorpusItem } from "./clip-service";
import type { Transcript } from "./transcript";
import {
  WorkflowLeaseLostError,
  incrementStageAttempt,
  isWorkflowLeaseExpired,
  newWorkflowRunId,
  withWorkflowHeartbeat,
} from "./workflow-lease";

export const MIND_ONBOARDING_STAGES = [
  "learning_voice",
  "waking_mind",
  "teaching_taste",
] as const;

export const CREATOR_MIND_STAGES = [
  "pending",
  ...MIND_ONBOARDING_STAGES,
  "ready",
  "failed",
] as const;

export type MindOnboardingStage = (typeof MIND_ONBOARDING_STAGES)[number];
export type CreatorMindStage = (typeof CREATOR_MIND_STAGES)[number];

export type FirstVideoOnboardingResult =
  | PipelineRunResult
  | {
      status: "failed";
      videoId: string;
      creatorId: string;
      failedStage: MindOnboardingStage;
      error: string;
    };

export type FirstVideoOnboardingOptions = {
  prismaClient?: PrismaClient;
  storage?: Pick<R2Storage, "presignSourceUrl">;
  transcribeItem?: (item: CorpusItem) => Promise<Transcript>;
  distillTenets?: (transcripts: WeightedTranscript[]) => Promise<InitialTenets>;
  mindsClient?: MindsClient | null;
  stewardEmail?: string;
  runPipelineImpl?: (
    videoId: string,
    options?: PipelineOptions,
  ) => Promise<PipelineRunResult>;
  pipelineOptions?: Omit<PipelineOptions, "prismaClient">;
  now?: Date;
  heartbeatIntervalMs?: number;
  onMindStageChange?: (stage: CreatorMindStage) => void | Promise<void>;
};

type CreatorMindState = {
  mindId: string | null;
  mindStage: string | null;
  mindLeaseHeartbeatAt?: Date | null;
};

export function creatorHasReadyMind(creator: CreatorMindState): boolean {
  if (!creator.mindId?.trim()) {
    return false;
  }

  return (
    creator.mindStage === null ||
    creator.mindStage === "ready"
  );
}

export function creatorNeedsMindOnboarding(creator: CreatorMindState): boolean {
  return !creatorHasReadyMind(creator);
}

export function failedMindOnboardingStage(
  mindError: string | null | undefined,
): MindOnboardingStage {
  const prefix = mindError?.split(":", 1)[0]?.trim();
  return isMindOnboardingStage(prefix) ? prefix : "learning_voice";
}

export function isMindOnboardingStage(
  value: string | null | undefined,
): value is MindOnboardingStage {
  return MIND_ONBOARDING_STAGES.includes(value as MindOnboardingStage);
}

export function canRetryMindOnboardingStage(
  creator: {
    mindStage: string | null;
    mindLeaseHeartbeatAt: Date | null;
  },
  now: Date = new Date(),
): boolean {
  if (creator.mindStage === "failed") {
    return true;
  }

  return (
    isMindOnboardingStage(creator.mindStage) &&
    isWorkflowLeaseExpired(creator.mindLeaseHeartbeatAt, now)
  );
}

export async function runFirstVideoOnboardingPipeline(
  videoId: string,
  options: FirstVideoOnboardingOptions = {},
): Promise<FirstVideoOnboardingResult> {
  const db = options.prismaClient ?? prisma;
  const runId = newWorkflowRunId("mind-onboarding");
  const video = await db.video.findUnique({
    where: {
      id: videoId,
    },
    select: {
      id: true,
      creatorId: true,
      sourceKey: true,
      creator: {
        select: {
          id: true,
          mindId: true,
          mindStage: true,
          mindError: true,
          mindRunId: true,
          mindLeaseHeartbeatAt: true,
          mindStageAttempts: true,
          initialTenets: true,
        },
      },
    },
  });

  if (!video) {
    throw new Error(`Video ${videoId} does not exist.`);
  }
  const sourceKey = video.sourceKey;
  if (!sourceKey) {
    throw new Error(`Video ${videoId} does not have an uploaded source key.`);
  }

  if (creatorHasReadyMind(video.creator)) {
    return runNormalPipeline(video.id, db, options);
  }

  let activeStage = resolveMindStartStage(video.creator);
  let mindId = video.creator.mindId?.trim() || null;
  let tenets: InitialTenets | null = null;
  await claimMindOnboardingRun(db, video.creatorId, runId, options);

  try {
    if (shouldRunMindStage(activeStage, "learning_voice")) {
      activeStage = "learning_voice";
      await setCreatorMindStage(db, video.creatorId, runId, activeStage, options);
      tenets = await withWorkflowHeartbeat(
        () => heartbeatMindOnboardingRun(db, video.creatorId, runId, options),
        () => learnVoiceFromVideo(sourceKey, options),
        options.heartbeatIntervalMs,
      );
      const tenetsStored = await db.creator.updateMany({
        where: {
          id: video.creatorId,
          mindRunId: runId,
        },
        data: {
          initialTenets: toPrismaJson(tenets),
          mindLeaseHeartbeatAt: options.now ?? new Date(),
        },
      });
      if (tenetsStored.count !== 1) {
        throw new WorkflowLeaseLostError("Mind onboarding", video.creatorId);
      }
    } else {
      tenets = readTenets(video.creator.initialTenets);
    }

    if (shouldRunMindStage(activeStage, "waking_mind")) {
      activeStage = "waking_mind";
      await setCreatorMindStage(db, video.creatorId, runId, activeStage, options);
      if (!mindId) {
        const mindsClient = requireMindsClient(options.mindsClient);
        const mind = await withWorkflowHeartbeat(
          () => heartbeatMindOnboardingRun(db, video.creatorId, runId, options),
          () =>
            createCreatorMind({
              creatorId: video.creatorId,
              stewardEmail: options.stewardEmail ?? DEFAULT_CREATOR_STEWARD_EMAIL,
              mindsClient,
            }),
          options.heartbeatIntervalMs,
        );
        mindId = mind.mindId;
        const mindStored = await db.creator.updateMany({
          where: {
            id: video.creatorId,
            mindRunId: runId,
          },
          data: {
            mindId,
            mindLeaseHeartbeatAt: options.now ?? new Date(),
          },
        });
        if (mindStored.count !== 1) {
          throw new WorkflowLeaseLostError("Mind onboarding", video.creatorId);
        }
      }
    }

    if (shouldRunMindStage(activeStage, "teaching_taste")) {
      activeStage = "teaching_taste";
      await setCreatorMindStage(db, video.creatorId, runId, activeStage, options);
      const mindsClient = requireMindsClient(options.mindsClient);
      if (!mindId) {
        throw new Error("Creator Mind id was missing before Tenet seeding.");
      }
      if (!tenets) {
        throw new Error("Initial Tenets were missing before Tenet seeding.");
      }
      const seededMindId = mindId;
      const seededTenets = tenets;

      await withWorkflowHeartbeat(
        () => heartbeatMindOnboardingRun(db, video.creatorId, runId, options),
        () => seedCreatorTenets(mindsClient, seededMindId, seededTenets),
        options.heartbeatIntervalMs,
      );
      const completed = await db.creator.updateMany({
        where: {
          id: video.creatorId,
          mindRunId: runId,
        },
        data: {
          initialTenets: toPrismaJson(seededTenets),
          mindStage: "ready",
          mindError: null,
          mindLeaseHeartbeatAt: options.now ?? new Date(),
        },
      });
      if (completed.count !== 1) {
        throw new WorkflowLeaseLostError("Mind onboarding", video.creatorId);
      }
      await options.onMindStageChange?.("ready");
    }

    return runNormalPipeline(video.id, db, options);
  } catch (error) {
    const failedStage = activeStage;
    const errorText = `${failedStage}: ${shortErrorMessage(error)}`;
    await markMindOnboardingFailed(db, video.creatorId, runId, errorText, options);
    await options.onMindStageChange?.("failed");

    return {
      status: "failed",
      videoId: video.id,
      creatorId: video.creatorId,
      failedStage,
      error: errorText,
    };
  }
}

async function learnVoiceFromVideo(
  sourceKey: string,
  options: FirstVideoOnboardingOptions,
): Promise<InitialTenets> {
  const storage = options.storage ?? createR2Storage();
  const sourceUrl = await storage.presignSourceUrl(sourceKey);
  const corpusItems: CorpusItem[] = [
    {
      source: sourceUrl,
      sourceType: "source_video",
      weight: CORPUS_WEIGHTS.source_video,
    },
  ];
  const transcribeItem =
    options.transcribeItem ??
    createClipServiceTranscriber(clipServiceConfigFromEnv());
  const distillTenets = options.distillTenets ?? createOpenAITenetDistiller();
  const transcripts = await transcribeCorpusItems(corpusItems, transcribeItem);

  return distillCorpusTenets(transcripts, distillTenets);
}

function requireMindsClient(
  mindsClient: MindsClient | null | undefined,
): MindsClient {
  const client = mindsClient ?? createMindsClientFromEnv();
  if (!client) {
    throw new Error(`${MINDS_BUILDER_API_KEY_ENV} is required to create a Mind.`);
  }

  return client;
}

async function runNormalPipeline(
  videoId: string,
  db: PrismaClient,
  options: FirstVideoOnboardingOptions,
): Promise<PipelineRunResult> {
  const pipeline = options.runPipelineImpl ?? runPipeline;
  return pipeline(videoId, {
    now: options.now,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    ...options.pipelineOptions,
    prismaClient: db,
  });
}

async function setCreatorMindStage(
  db: PrismaClient,
  creatorId: string,
  runId: string,
  stage: MindOnboardingStage,
  options: FirstVideoOnboardingOptions,
): Promise<void> {
  const creator = await db.creator.findUniqueOrThrow({
    where: {
      id: creatorId,
    },
    select: {
      mindRunId: true,
      mindStageAttempts: true,
    },
  });
  if (creator.mindRunId !== runId) {
    throw new WorkflowLeaseLostError("Mind onboarding", creatorId);
  }

  const updated = await db.creator.updateMany({
    where: {
      id: creatorId,
      mindRunId: runId,
    },
    data: {
      mindStage: stage,
      mindError: null,
      mindLeaseHeartbeatAt: options.now ?? new Date(),
      mindStageAttempts: incrementStageAttempt(creator.mindStageAttempts, stage),
    },
  });
  if (updated.count !== 1) {
    throw new WorkflowLeaseLostError("Mind onboarding", creatorId);
  }
  await options.onMindStageChange?.(stage);
}

async function claimMindOnboardingRun(
  db: PrismaClient,
  creatorId: string,
  runId: string,
  options: FirstVideoOnboardingOptions,
): Promise<void> {
  await db.creator.update({
    where: {
      id: creatorId,
    },
    data: {
      mindRunId: runId,
      mindLeaseHeartbeatAt: options.now ?? new Date(),
    },
  });
}

async function heartbeatMindOnboardingRun(
  db: PrismaClient,
  creatorId: string,
  runId: string,
  options: FirstVideoOnboardingOptions,
): Promise<void> {
  const updated = await db.creator.updateMany({
    where: {
      id: creatorId,
      mindRunId: runId,
    },
    data: {
      mindLeaseHeartbeatAt: options.now ?? new Date(),
    },
  });
  if (updated.count !== 1) {
    throw new WorkflowLeaseLostError("Mind onboarding", creatorId);
  }
}

async function markMindOnboardingFailed(
  db: PrismaClient,
  creatorId: string,
  runId: string,
  errorText: string,
  options: FirstVideoOnboardingOptions,
): Promise<void> {
  const updated = await db.creator.updateMany({
    where: {
      id: creatorId,
      mindRunId: runId,
    },
    data: {
      mindStage: "failed",
      mindError: errorText,
      mindLeaseHeartbeatAt: options.now ?? new Date(),
    },
  });
  if (updated.count !== 1) {
    throw new WorkflowLeaseLostError("Mind onboarding", creatorId);
  }
}

function resolveMindStartStage(creator: {
  mindId: string | null;
  mindStage: string | null;
  mindError: string | null;
  initialTenets: Prisma.JsonValue;
}): MindOnboardingStage {
  if (creator.mindStage === "failed") {
    return failedMindOnboardingStage(creator.mindError);
  }
  if (isMindOnboardingStage(creator.mindStage)) {
    return creator.mindStage;
  }
  if (!creator.initialTenets) {
    return "learning_voice";
  }
  if (!creator.mindId?.trim()) {
    return "waking_mind";
  }

  return "teaching_taste";
}

function shouldRunMindStage(
  current: MindOnboardingStage,
  target: MindOnboardingStage,
): boolean {
  return mindStageIndex(current) <= mindStageIndex(target);
}

function mindStageIndex(stage: MindOnboardingStage): number {
  return MIND_ONBOARDING_STAGES.indexOf(stage);
}

function readTenets(value: Prisma.JsonValue): InitialTenets | null {
  if (value === null) {
    return null;
  }

  return parseInitialTenets(value);
}

function toPrismaJson(tenets: InitialTenets): Prisma.InputJsonValue {
  return tenets as unknown as Prisma.InputJsonValue;
}

function shortErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message || "Unknown error.").replace(/\s+/g, " ").slice(0, 280);
}
