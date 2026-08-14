import { Prisma, type PrismaClient } from "@prisma/client";

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
import {
  syncTasteFeedback,
  type SyncTasteFeedbackOptions,
  type SyncTasteFeedbackResult,
} from "./tasteFeedback";
import {
  generateClipThumbnail,
  type GenerateClipThumbnailOptions,
  type GenerateClipThumbnailResult,
} from "./thumbnails";
import {
  WorkflowLeaseLostError,
  incrementStageAttempt,
  isWorkflowLeaseExpired,
  newWorkflowRunId,
  withWorkflowHeartbeat,
} from "./workflow-lease";

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
export type ActivePipelineStage = Exclude<PipelineStage, "done" | "failed">;

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

type GenerateClipThumbnailImpl = (
  clipId: string,
  options?: GenerateClipThumbnailOptions,
) => Promise<GenerateClipThumbnailResult>;

type SyncTasteFeedbackImpl = (
  creatorId: string,
  options?: SyncTasteFeedbackOptions,
) => Promise<SyncTasteFeedbackResult>;

export type PipelineOptions = {
  prismaClient?: PrismaClient;
  ingestUploadedVideoImpl?: IngestUploadedVideoImpl;
  ingestOptions?: Omit<IngestUploadedVideoOptions, "prismaClient">;
  rankCandidatesImpl?: RankCandidatesImpl;
  rankOptions?: Omit<RankCandidatesOptions, "prismaClient">;
  captionClipImpl?: CaptionClipImpl;
  captionOptions?: Omit<CaptionClipOptions, "prismaClient">;
  generateClipThumbnailImpl?: GenerateClipThumbnailImpl;
  thumbnailOptions?: Omit<GenerateClipThumbnailOptions, "prismaClient">;
  thumbnailLogger?: Pick<Console, "warn">;
  syncTasteFeedbackImpl?: SyncTasteFeedbackImpl;
  tasteFeedbackOptions?: Omit<SyncTasteFeedbackOptions, "prismaClient">;
  tasteFeedbackLogger?: Pick<Console, "error">;
  now?: Date;
  heartbeatIntervalMs?: number;
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
  const runId = newWorkflowRunId("pipeline");
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
    await syncTasteFeedbackAfterPipeline(db, video.creatorId, options);
    return doneResult(db, video.id, video.creatorId, []);
  }
  if (activeStage === "uploaded") {
    activeStage = "transcribing";
  }
  await claimPipelineRun(db, video.id, runId, options);

  const ingestImpl = options.ingestUploadedVideoImpl ?? ingestUploadedVideo;
  const rankImpl = options.rankCandidatesImpl ?? rankCandidates;
  const captionImpl = options.captionClipImpl ?? captionClip;
  const thumbnailImpl = options.generateClipThumbnailImpl ?? generateClipThumbnail;
  const captionedClipIds: string[] = [];

  try {
    if (shouldRun(activeStage, "transcribing")) {
      activeStage = "transcribing";
      await setPipelineStage(db, video.id, runId, activeStage, options);
      await withWorkflowHeartbeat(
        () => heartbeatPipelineRun(db, video.id, runId, options),
        () =>
          ingestImpl(video.id, {
            ...options.ingestOptions,
            prismaClient: db,
          }),
        options.heartbeatIntervalMs,
      );
    }

    if (shouldRun(activeStage, "candidates")) {
      activeStage = "candidates";
      await setPipelineStage(db, video.id, runId, activeStage, options);
      await assertCandidateClips(db, video.id, video.creatorId);
      await withWorkflowHeartbeat(
        () => heartbeatPipelineRun(db, video.id, runId, options),
        () =>
          generateCandidateThumbnails(
            db,
            video.id,
            video.creatorId,
            thumbnailImpl,
            options,
          ),
        options.heartbeatIntervalMs,
      );
    }

    if (shouldRun(activeStage, "ranking")) {
      activeStage = "ranking";
      await setPipelineStage(db, video.id, runId, activeStage, options);
      const rankResult = await withWorkflowHeartbeat(
        () => heartbeatPipelineRun(db, video.id, runId, options),
        () =>
          rankImpl(video.creatorId, video.id, {
            ...options.rankOptions,
            prismaClient: db,
          }),
        options.heartbeatIntervalMs,
      );
      assertRanked(rankResult);
    }

    if (shouldRun(activeStage, "captions")) {
      activeStage = "captions";
      await setPipelineStage(db, video.id, runId, activeStage, options);
      const topClips = await loadTopRankedCandidateClips(
        db,
        video.id,
        video.creatorId,
      );
      if (topClips.length === 0) {
        throw new Error("No Mind-ranked clips found for captioning.");
      }

      for (const clip of topClips) {
        const captionResult = await withWorkflowHeartbeat(
          () => heartbeatPipelineRun(db, video.id, runId, options),
          () =>
            captionImpl(clip.id, {
              ...options.captionOptions,
              prismaClient: db,
            }),
          options.heartbeatIntervalMs,
        );
        assertCaptioned(captionResult, clip.id);
        captionedClipIds.push(clip.id);
      }
    }

    await captionAcceptedClipsMissingPostCopy(
      db,
      video.id,
      video.creatorId,
      runId,
      captionImpl,
      options,
      captionedClipIds,
    );
    await setPipelineStage(db, video.id, runId, "done", options);
    await runSchedulePass(video.creatorId, new Date(), {
      prismaClient: db,
    });
    await syncTasteFeedbackAfterPipeline(db, video.creatorId, options);
    return doneResult(db, video.id, video.creatorId, captionedClipIds);
  } catch (error) {
    const failedStage = toRetryableStage(activeStage);
    const errorText = `${failedStage}: ${shortErrorMessage(error)}`;
    await markPipelineFailed(db, video.id, runId, errorText, options);
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

async function syncTasteFeedbackAfterPipeline(
  db: PrismaClient,
  creatorId: string,
  options: PipelineOptions,
): Promise<void> {
  const syncImpl = options.syncTasteFeedbackImpl ?? syncTasteFeedback;

  try {
    await syncImpl(creatorId, {
      ...options.tasteFeedbackOptions,
      prismaClient: db,
    });
  } catch (error) {
    (options.tasteFeedbackLogger ?? console).error(
      `Taste feedback sync failed after pipeline for creator ${creatorId}: ${shortErrorMessage(error)}`,
    );
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
      pipelineLeaseHeartbeatAt: true,
    },
  });

  if (!video) {
    throw new Error(`Video ${videoId} does not exist.`);
  }
  if (!canRetryPipelineStage(video, options.now)) {
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

export function isActivePipelineStage(
  stage: string | null | undefined,
): stage is ActivePipelineStage {
  return (
    isPipelineStage(stage) &&
    stage !== "done" &&
    stage !== "failed"
  );
}

export function canRetryPipelineStage(
  video: {
    pipelineStage: string | null;
    pipelineLeaseHeartbeatAt: Date | null;
  },
  now: Date = new Date(),
): boolean {
  if (video.pipelineStage === "failed") {
    return true;
  }

  return (
    isActivePipelineStage(video.pipelineStage) &&
    isWorkflowLeaseExpired(video.pipelineLeaseHeartbeatAt, now)
  );
}

async function setPipelineStage(
  db: PrismaClient,
  videoId: string,
  runId: string,
  stage: Exclude<PipelineStage, "failed">,
  options: PipelineOptions,
): Promise<void> {
  const data: Prisma.VideoUpdateManyMutationInput = {
    pipelineStage: stage,
    pipelineError: null,
    pipelineRunId: runId,
    pipelineLeaseHeartbeatAt: options.now ?? new Date(),
  };

  if (isActivePipelineStage(stage)) {
    const video = await db.video.findUniqueOrThrow({
      where: {
        id: videoId,
      },
      select: {
        pipelineRunId: true,
        pipelineStageAttempts: true,
      },
    });
    if (video.pipelineRunId !== runId) {
      throw new WorkflowLeaseLostError("Pipeline", videoId);
    }
    data.pipelineStageAttempts = incrementStageAttempt(
      video.pipelineStageAttempts,
      stage,
    );
  }

  const updated = await db.video.updateMany({
    where: {
      id: videoId,
      pipelineRunId: runId,
    },
    data,
  });
  if (updated.count !== 1) {
    throw new WorkflowLeaseLostError("Pipeline", videoId);
  }
  await options.onStageChange?.(stage);
}

async function claimPipelineRun(
  db: PrismaClient,
  videoId: string,
  runId: string,
  options: PipelineOptions,
): Promise<void> {
  await db.video.update({
    where: {
      id: videoId,
    },
    data: {
      pipelineRunId: runId,
      pipelineLeaseHeartbeatAt: options.now ?? new Date(),
    },
  });
}

async function heartbeatPipelineRun(
  db: PrismaClient,
  videoId: string,
  runId: string,
  options: PipelineOptions,
): Promise<void> {
  const updated = await db.video.updateMany({
    where: {
      id: videoId,
      pipelineRunId: runId,
    },
    data: {
      pipelineLeaseHeartbeatAt: options.now ?? new Date(),
    },
  });
  if (updated.count !== 1) {
    throw new WorkflowLeaseLostError("Pipeline", videoId);
  }
}

async function markPipelineFailed(
  db: PrismaClient,
  videoId: string,
  runId: string,
  errorText: string,
  options: PipelineOptions,
): Promise<void> {
  const updated = await db.video.updateMany({
    where: {
      id: videoId,
      pipelineRunId: runId,
    },
    data: {
      pipelineStage: "failed",
      pipelineError: errorText,
      pipelineLeaseHeartbeatAt: options.now ?? new Date(),
    },
  });
  if (updated.count !== 1) {
    throw new WorkflowLeaseLostError("Pipeline", videoId);
  }
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

async function generateCandidateThumbnails(
  db: PrismaClient,
  videoId: string,
  creatorId: string,
  thumbnailImpl: GenerateClipThumbnailImpl,
  options: PipelineOptions,
): Promise<void> {
  const clips = await db.clip.findMany({
    where: {
      videoId,
      creatorId,
      status: "candidate",
    },
    orderBy: [
      {
        startMs: "asc",
      },
      {
        id: "asc",
      },
    ],
    select: {
      id: true,
    },
  });

  for (const clip of clips) {
    try {
      await thumbnailImpl(clip.id, {
        ...options.thumbnailOptions,
        prismaClient: db,
      });
    } catch (error) {
      (options.thumbnailLogger ?? console).warn(
        `Thumbnail generation failed for clip ${clip.id}: ${shortErrorMessage(error)}`,
      );
    }
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

async function captionAcceptedClipsMissingPostCopy(
  db: PrismaClient,
  videoId: string,
  creatorId: string,
  runId: string,
  captionImpl: CaptionClipImpl,
  options: PipelineOptions,
  captionedClipIds: string[],
): Promise<void> {
  const clips = await db.clip.findMany({
    where: {
      videoId,
      creatorId,
      status: "accepted",
      postCopyVariants: {
        equals: Prisma.AnyNull,
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
    select: {
      id: true,
    },
  });

  for (const clip of clips) {
    const captionResult = await withWorkflowHeartbeat(
      () => heartbeatPipelineRun(db, videoId, runId, options),
      () =>
        captionImpl(clip.id, {
          ...options.captionOptions,
          prismaClient: db,
        }),
      options.heartbeatIntervalMs,
    );
    assertCaptioned(captionResult, clip.id);
    captionedClipIds.push(clip.id);
  }
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

function isPipelineStage(
  stage: string | null | undefined,
): stage is PipelineStage {
  return PIPELINE_STAGES.includes(stage as PipelineStage);
}

function shortErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message || "Unknown error.").replace(/\s+/g, " ").slice(0, 280);
}
