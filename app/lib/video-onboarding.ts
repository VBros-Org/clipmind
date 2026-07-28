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
  onMindStageChange?: (stage: CreatorMindStage) => void | Promise<void>;
};

type CreatorMindState = {
  mindId: string | null;
  mindStage: string | null;
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

export async function runFirstVideoOnboardingPipeline(
  videoId: string,
  options: FirstVideoOnboardingOptions = {},
): Promise<FirstVideoOnboardingResult> {
  const db = options.prismaClient ?? prisma;
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
          initialTenets: true,
        },
      },
    },
  });

  if (!video) {
    throw new Error(`Video ${videoId} does not exist.`);
  }
  if (!video.sourceKey) {
    throw new Error(`Video ${videoId} does not have an uploaded source key.`);
  }

  if (creatorHasReadyMind(video.creator)) {
    return runNormalPipeline(video.id, db, options);
  }

  let activeStage = resolveMindStartStage(video.creator);
  let mindId = video.creator.mindId?.trim() || null;
  let tenets = readTenets(video.creator.initialTenets);

  try {
    if (shouldRunMindStage(activeStage, "learning_voice")) {
      activeStage = "learning_voice";
      await setCreatorMindStage(db, video.creatorId, activeStage, options);
      tenets = await learnVoiceFromVideo(video.sourceKey, options);
      await db.creator.update({
        where: {
          id: video.creatorId,
        },
        data: {
          initialTenets: toPrismaJson(tenets),
        },
      });
    }

    if (shouldRunMindStage(activeStage, "waking_mind")) {
      activeStage = "waking_mind";
      await setCreatorMindStage(db, video.creatorId, activeStage, options);
      if (!mindId) {
        const mindsClient = requireMindsClient(options.mindsClient);
        const mind = await createCreatorMind({
          creatorId: video.creatorId,
          stewardEmail: options.stewardEmail ?? DEFAULT_CREATOR_STEWARD_EMAIL,
          mindsClient,
        });
        mindId = mind.mindId;
        await db.creator.update({
          where: {
            id: video.creatorId,
          },
          data: {
            mindId,
          },
        });
      }
    }

    if (shouldRunMindStage(activeStage, "teaching_taste")) {
      activeStage = "teaching_taste";
      await setCreatorMindStage(db, video.creatorId, activeStage, options);
      const mindsClient = requireMindsClient(options.mindsClient);
      if (!mindId) {
        throw new Error("Creator Mind id was missing before Tenet seeding.");
      }
      if (!tenets) {
        throw new Error("Initial Tenets were missing before Tenet seeding.");
      }

      await seedCreatorTenets(mindsClient, mindId, tenets);
      await db.creator.update({
        where: {
          id: video.creatorId,
        },
        data: {
          initialTenets: toPrismaJson(tenets),
          mindStage: "ready",
          mindError: null,
        },
      });
      await options.onMindStageChange?.("ready");
    }

    return runNormalPipeline(video.id, db, options);
  } catch (error) {
    const failedStage = activeStage;
    const errorText = `${failedStage}: ${shortErrorMessage(error)}`;
    await db.creator.update({
      where: {
        id: video.creatorId,
      },
      data: {
        mindStage: "failed",
        mindError: errorText,
      },
    });
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
    ...options.pipelineOptions,
    prismaClient: db,
  });
}

async function setCreatorMindStage(
  db: PrismaClient,
  creatorId: string,
  stage: MindOnboardingStage,
  options: FirstVideoOnboardingOptions,
): Promise<void> {
  await db.creator.update({
    where: {
      id: creatorId,
    },
    data: {
      mindStage: stage,
      mindError: null,
    },
  });
  await options.onMindStageChange?.(stage);
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
