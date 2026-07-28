import type { PrismaClient } from "@prisma/client";

import {
  captionClip,
  type CaptionClipOptions,
  type CaptionClipResult,
} from "./captioning";
import { prisma } from "./db";
import {
  ingestUploadedVideo,
  type IngestUploadedVideoOptions,
  type IngestVideoResult,
} from "./ingest";
import {
  rankCandidates,
  type RankCandidatesOptions,
  type RankCandidatesResult,
} from "./ranking";
import { runSchedulePass } from "./scheduling-repository";

export const PIPELINE_STAGES = [
  "uploaded",
  "transcribing",
  "candidates",
  "ranking",
  "captions",
  "done",
  "failed",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export type RetryablePipelineStage = Exclude<
  PipelineStage,
  "done" | "failed" | "uploaded"
>;

export type PipelineRunResult =
  | {
      status: "done";
      videoId: string;
      creatorId: string;
      clipCount: number;
      captionedClipIds: string[];
    }
  | {
      status: "failed";
      videoId: string;
      creatorId: string;
      failedStage: RetryablePipelineStage;
      error: string;
    };

export class PipelineRetryNotAllowedError extends Error {
  constructor(videoId: string, stage: string | null) {
    super(
      `Video ${videoId} is not failed. Current pipeline stage is ${stage ?? "unset"}.`,
    );
  }
}

type IngestUploadedVideoImpl = (
  videoId: string,
  options?: IngestUploadedVideoOptions,
) => Promise<IngestVideoResult>;

type RankCandidatesImpl = (
  creatorId: string,
  videoId: string,
  options?: RankCandidatesOptions,
) => Promise<RankCandidatesResult>;

type CaptionClipImpl = (
  clipId: string,
  options?: CaptionClipOptions,
) => Promise<CaptionClipResult>;

export type PipelineOptions = {
  prismaClient?: PrismaClient;
  ingestUploadedVideoImpl?: IngestUploadedVideoImpl;
  ingestOptions?: Omit<IngestUploadedVideoOptions, "prismaClient">;
  rankCandidatesImpl?: RankCandidatesImpl;
  rankOptions?: Omit<RankCandidatesOptions, "prismaClient">;
  captionClipImpl?: CaptionClipImpl;
  captionOptions?: Omit<CaptionClipOptions, "prismaClient">;
  onStageChange?: (stage: PipelineStage) => void | Promise<void>;
};

const STAGE_INDEX: Record<Exclude<PipelineStage, "failed">, number> = {
  uploaded: 0,
  transcribing: 1,
  candidates: 2,
  ranking: 3,
  captions: 4,
  done: 5,
};

const RETRYABLE_STAGES = new Set<RetryablePipelineStage>([
  "transcribing",
  "candidates",
  "ranking",
  "captions",
]);

export async function runPipeline(
  videoId: string,
  options: PipelineOptions = {},
): Promise<PipelineRunResult> {
  const db = options.prismaClient ?? prisma;
  const video = await db.video.findUnique({
    where: {
      id: videoId,
    },
    select: {
      id: true,
      creatorId: true,
      pipelineStage: true,
      pipelineError: true,
    },
  });

  if (!video) {
    throw new Error(`Video ${videoId} does not exist.`);
  }

  let activeStage = resolveStartStage(video.pipelineStage, video.pipelineError);
  if (activeStage === "done") {
    return doneResult(db, video.id, video.creatorId, []);
  }
  if (activeStage === "uploaded") {
    activeStage = "transcribing";
  }

  const ingestImpl = options.ingestUploadedVideoImpl ?? ingestUploadedVideo;
  const rankImpl = options.rankCandidatesImpl ?? rankCandidates;
  const captionImpl = options.captionClipImpl ?? captionClip;
  const captionedClipIds: string[] = [];

  try {
    if (shouldRun(activeStage, "transcribing")) {
      activeStage = "transcribing";
      await setPipelineStage(db, video.id, activeStage, options);
      await ingestImpl(video.id, {
        ...options.ingestOptions,
        prismaClient: db,
      });
    }

    if (shouldRun(activeStage, "candidates")) {
      activeStage = "candidates";
      await setPipelineStage(db, video.id, activeStage, options);
      await assertCandidateClips(db, video.id, video.creatorId);
    }

    if (shouldRun(activeStage, "ranking")) {
      activeStage = "ranking";
      await setPipelineStage(db, video.id, activeStage, options);
      const rankResult = await rankImpl(video.creatorId, video.id, {
        ...options.rankOptions,
        prismaClient: db,
      });
      assertRanked(rankResult);
    }

    if (shouldRun(activeStage, "captions")) {
      activeStage = "captions";
      await setPipelineStage(db, video.id, activeStage, options);
      const topClips = await loadTopRankedCandidateClips(
        db,
        video.id,
        video.creatorId,
      );
      if (topClips.length === 0) {
        throw new Error("No Mind-ranked clips found for captioning.");
      }

      for (const clip of topClips) {
        const captionResult = await captionImpl(clip.id, {
          ...options.captionOptions,
          prismaClient: db,
        });
        assertCaptioned(captionResult, clip.id);
        captionedClipIds.push(clip.id);
      }
    }

    await setPipelineStage(db, video.id, "done", options);
    await runSchedulePass(video.creatorId, new Date(), {
      prismaClient: db,
    });
    return doneResult(db, video.id, video.creatorId, captionedClipIds);
  } catch (error) {
    const failedStage = toRetryableStage(activeStage);
    const errorText = `${failedStage}: ${shortErrorMessage(error)}`;
    await db.video.update({
      where: {
        id: video.id,
      },
      data: {
        pipelineStage: "failed",
        pipelineError: errorText,
      },
    });
    await options.onStageChange?.("failed");

    return {
      status: "failed",
      videoId: video.id,
      creatorId: video.creatorId,
      failedStage,
      error: errorText,
    };
  }
}

export async function retryPipeline(
  videoId: string,
  options: PipelineOptions = {},
): Promise<PipelineRunResult> {
  const db = options.prismaClient ?? prisma;
  const video = await db.video.findUnique({
    where: {
      id: videoId,
    },
    select: {
      pipelineStage: true,
    },
  });

  if (!video) {
    throw new Error(`Video ${videoId} does not exist.`);
  }
  if (video.pipelineStage !== "failed") {
    throw new PipelineRetryNotAllowedError(videoId, video.pipelineStage);
  }

  return runPipeline(videoId, options);
}

export function failedPipelineStage(
  pipelineError: string | null | undefined,
): RetryablePipelineStage {
  const prefix = pipelineError?.split(":", 1)[0]?.trim();
  return toRetryableStage(prefix);
}

function resolveStartStage(
  stage: string | null,
  error: string | null,
): Exclude<PipelineStage, "failed"> {
  if (stage === "failed") {
    return failedPipelineStage(error);
  }

  if (isPipelineStage(stage) && stage !== "failed") {
    return stage;
  }

  return "uploaded";
}

function shouldRun(
  current: Exclude<PipelineStage, "failed">,
  target: RetryablePipelineStage,
): boolean {
  return STAGE_INDEX[current] <= STAGE_INDEX[target];
}

async function setPipelineStage(
  db: PrismaClient,
  videoId: string,
  stage: Exclude<PipelineStage, "failed">,
  options: PipelineOptions,
): Promise<void> {
  await db.video.update({
    where: {
      id: videoId,
    },
    data: {
      pipelineStage: stage,
      pipelineError: null,
    },
  });
  await options.onStageChange?.(stage);
}

async function assertCandidateClips(
  db: PrismaClient,
  videoId: string,
  creatorId: string,
): Promise<void> {
  const count = await db.clip.count({
    where: {
      videoId,
      creatorId,
      status: "candidate",
    },
  });

  if (count === 0) {
    throw new Error("No clip candidates returned.");
  }
}

function assertRanked(result: RankCandidatesResult): void {
  if (result.status === "ranked") {
    return;
  }

  if (result.status === "empty") {
    throw new Error("No candidate clips were available for Mind ranking.");
  }

  throw new Error(`Mind ranking failed: ${result.reason}.`);
}

async function loadTopRankedCandidateClips(
  db: PrismaClient,
  videoId: string,
  creatorId: string,
): Promise<{ id: string }[]> {
  return db.clip.findMany({
    where: {
      videoId,
      creatorId,
      status: "candidate",
      mindRank: {
        not: null,
      },
    },
    orderBy: [
      {
        mindRank: "asc",
      },
      {
        createdAt: "asc",
      },
      {
        id: "asc",
      },
    ],
    take: 2,
    select: {
      id: true,
    },
  });
}

function assertCaptioned(result: CaptionClipResult, clipId: string): void {
  if (result.status === "captioned") {
    return;
  }

  const detail = result.errors[0] ? ` ${result.errors[0]}` : "";
  throw new Error(`Clip ${clipId} caption failed: ${result.reason}.${detail}`);
}

async function doneResult(
  db: PrismaClient,
  videoId: string,
  creatorId: string,
  captionedClipIds: string[],
): Promise<PipelineRunResult> {
  const clipCount = await db.clip.count({
    where: {
      videoId,
      creatorId,
    },
  });

  return {
    status: "done",
    videoId,
    creatorId,
    clipCount,
    captionedClipIds,
  };
}

function toRetryableStage(
  stage: string | null | undefined,
): RetryablePipelineStage {
  return RETRYABLE_STAGES.has(stage as RetryablePipelineStage)
    ? (stage as RetryablePipelineStage)
    : "transcribing";
}

function isPipelineStage(stage: string | null): stage is PipelineStage {
  return PIPELINE_STAGES.includes(stage as PipelineStage);
}

function shortErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message || "Unknown error.").replace(/\s+/g, " ").slice(0, 280);
}
