import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";

import busboy from "busboy";
import type { PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import { loadRecentUploads } from "./app-overview";
import { publicUploadWorkflowErrorMessage } from "./public-upload-errors";
import {
  PIPELINE_STAGES,
  canRetryPipelineStage,
  failedPipelineStage,
  retryPipeline,
  runPipeline,
  type PipelineRunResult,
  type PipelineStage,
} from "./pipeline";
import { loadCreatorSessionFromCookieHeader } from "./review-auth";
import {
  createR2Storage,
  publicMediaKeyFromUrl,
  sourceKeyForVideo,
  type R2Storage,
  type SourceUploadPart,
  type StorageUploadBody,
} from "./storage";
import {
  creatorNeedsMindOnboarding,
  canRetryMindOnboardingStage,
  failedMindOnboardingStage,
  isMindOnboardingStage,
  runFirstVideoOnboardingPipeline,
  type FirstVideoOnboardingResult,
  type MindOnboardingStage,
} from "./video-onboarding";
import { newWorkflowRunId, workflowLeaseExpiredError } from "./workflow-lease";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_UPLOAD_BYTES_LABEL = "2 GB";
export const MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const MIN_MULTIPART_PART_BYTES = 10 * 1024 * 1024;
export const MAX_SIGNED_UPLOAD_PARTS = 64;
export const POSTED_HISTORY_DELETE_MESSAGE =
  "This video has posted clips. Posted history cannot be deleted.";

type RouteParams = { id: string } | Promise<{ id: string }>;
type UploadWorkflowStage = PipelineStage | MindOnboardingStage;
type BackgroundRunResult = PipelineRunResult | FirstVideoOnboardingResult;
type VideoDeleteStorage = Pick<R2Storage, "deleteSource" | "deleteMediaObject">;
type MultipartUploadStorage = Pick<
  R2Storage,
  | "createSourceMultipartUpload"
  | "presignSourcePartUpload"
  | "listSourceUploadParts"
  | "completeSourceMultipartUpload"
  | "abortSourceMultipartUpload"
  | "deleteSource"
>;

export type VideoApiOptions = {
  prismaClient?: PrismaClient;
  now?: Date;
  storage?: Pick<R2Storage, "uploadSource">;
  multipartStorage?: MultipartUploadStorage;
  deleteStorage?: VideoDeleteStorage;
  runPipelineImpl?: (videoId: string) => Promise<BackgroundRunResult>;
  retryPipelineImpl?: (videoId: string) => Promise<BackgroundRunResult>;
  runFirstVideoOnboardingPipelineImpl?: (
    videoId: string,
  ) => Promise<BackgroundRunResult>;
  deleteLogger?: Pick<Console, "error">;
};

type UploadedFile = {
  sourceKey: string;
  bytes: number;
};

type UploadIntentForMultipart = {
  id: string;
  creatorId: string;
  videoId: string | null;
  sourceKey: string;
  uploadId: string | null;
  fileName: string | null;
  contentType: string;
  declaredSizeBytes: bigint;
  partSizeBytes: number;
  status: string;
};

class VideoApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

class PostedHistoryDeleteError extends Error {
  constructor() {
    super(POSTED_HISTORY_DELETE_MESSAGE);
  }
}

export async function handleUploadVideo(
  request: Request,
  options: VideoApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  try {
    const fileSize = assertUploadRequest(request);

    const db = options.prismaClient ?? prisma;
    const storage = options.storage ?? createR2Storage();
    const creator = await db.creator.findUniqueOrThrow({
      where: {
        id: session.creatorId,
      },
      select: {
        mindId: true,
        mindStage: true,
      },
    });
    const runMindOnboarding = creatorNeedsMindOnboarding(creator);
    const videoId = randomUUID();
    const now = new Date();
    const upload = await streamMultipartVideoToStorage(
      request,
      videoId,
      storage,
      fileSize,
    );

    const video = await db.video.create({
      data: {
        id: videoId,
        creatorId: session.creatorId,
        sourceKey: upload.sourceKey,
        contentKey: `uploaded:${session.creatorId}:${videoId}`,
        status: "uploaded",
        pipelineStage: "uploaded",
        pipelineError: null,
        pipelineRunId: runMindOnboarding ? null : newWorkflowRunId("pipeline"),
        pipelineLeaseHeartbeatAt: runMindOnboarding ? null : now,
      },
      select: {
        id: true,
      },
    });

    if (runMindOnboarding) {
      await db.creator.update({
        where: {
          id: session.creatorId,
        },
        data: {
          mindStage: "learning_voice",
          mindError: null,
          mindRunId: newWorkflowRunId("mind-onboarding"),
          mindLeaseHeartbeatAt: now,
        },
      });
    }

    startPipelineInBackground(
      video.id,
      runMindOnboarding
        ? options.runFirstVideoOnboardingPipelineImpl ??
            runFirstVideoOnboardingPipeline
        : options.runPipelineImpl ?? runPipeline,
      "upload pipeline",
    );

    return json(
      {
        videoId: video.id,
        stage: runMindOnboarding ? "learning_voice" : "uploaded",
        bytes: upload.bytes,
      },
      202,
    );
  } catch (error) {
    if (error instanceof VideoApiError) {
      return json({ error: error.message }, error.status);
    }

    throw error;
  }
}

export async function handleCreateMultipartUpload(
  request: Request,
  options: VideoApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  try {
    const input = await readMultipartCreateInput(request);
    const db = options.prismaClient ?? prisma;
    const storage = options.multipartStorage ?? createR2Storage();
    const intentId = randomUUID();
    const videoId = randomUUID();
    const sourceKey = sourceKeyForVideo(videoId);
    const now = new Date();

    await db.uploadIntent.create({
      data: {
        id: intentId,
        creatorId: session.creatorId,
        videoId,
        sourceKey,
        uploadId: null,
        fileName: input.fileName,
        contentType: input.contentType,
        declaredSizeBytes: BigInt(input.size),
        partSizeBytes: MULTIPART_PART_SIZE_BYTES,
        status: "creating",
        lastActivityAt: now,
      },
    });

    let uploadId: string | null = null;
    try {
      const created = await storage.createSourceMultipartUpload({
        key: sourceKey,
        contentType: input.contentType,
      });
      uploadId = created.uploadId;

      await db.uploadIntent.update({
        where: {
          id: intentId,
        },
        data: {
          uploadId,
          status: "uploading",
          lastActivityAt: new Date(),
        },
      });
    } catch (error) {
      if (uploadId) {
        await storage.abortSourceMultipartUpload({
          key: sourceKey,
          uploadId,
        });
      }

      await db.uploadIntent.updateMany({
        where: {
          id: intentId,
          status: {
            not: "completed",
          },
        },
        data: {
          status: "failed",
          failureReason: cappedErrorMessage(error),
          lastActivityAt: new Date(),
        },
      });

      throw error;
    }

    return json(
      {
        intentId,
        status: "uploading",
        fileName: input.fileName,
        size: input.size,
        partSizeBytes: MULTIPART_PART_SIZE_BYTES,
        uploadedParts: [],
      },
      201,
    );
  } catch (error) {
    if (error instanceof VideoApiError) {
      return json({ error: error.message }, error.status);
    }

    throw error;
  }
}

export async function handleGetMultipartUpload(
  request: Request,
  params: RouteParams,
  options: VideoApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  const db = options.prismaClient ?? prisma;
  const storage = options.multipartStorage ?? createR2Storage();
  const intent = await loadMultipartUploadIntent(
    db,
    await videoId(params),
    session.creatorId,
  );

  if (!intent) {
    return json({ error: "Upload not found." }, 404);
  }

  if (intent.status === "completed") {
    return json(
      multipartIntentResponse(intent, {
        uploadedParts: [],
      }),
      200,
    );
  }

  if (intent.status !== "uploading" || !intent.uploadId) {
    return json(
      multipartIntentResponse(intent, {
        uploadedParts: [],
      }),
      200,
    );
  }

  const uploadedParts = await storage.listSourceUploadParts({
    key: intent.sourceKey,
    uploadId: intent.uploadId,
  });
  await touchMultipartIntent(db, intent.id);

  return json(
    multipartIntentResponse(intent, {
      uploadedParts,
    }),
    200,
  );
}

export async function handleSignMultipartUploadParts(
  request: Request,
  params: RouteParams,
  options: VideoApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  try {
    const db = options.prismaClient ?? prisma;
    const storage = options.multipartStorage ?? createR2Storage();
    const intent = await loadMultipartUploadIntent(
      db,
      await videoId(params),
      session.creatorId,
    );

    if (!intent) {
      return json({ error: "Upload not found." }, 404);
    }
    if (intent.status !== "uploading" || !intent.uploadId) {
      return json({ error: "Upload is not active." }, 409);
    }

    const partNumbers = await readPartNumbers(request, intent);
    const urls = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await storage.presignSourcePartUpload({
          key: intent.sourceKey,
          uploadId: intent.uploadId ?? "",
          partNumber,
        }),
      })),
    );
    await touchMultipartIntent(db, intent.id);

    return json(
      {
        intentId: intent.id,
        urls,
      },
      200,
    );
  } catch (error) {
    if (error instanceof VideoApiError) {
      return json({ error: error.message }, error.status);
    }

    throw error;
  }
}

export async function handleCompleteMultipartUpload(
  request: Request,
  params: RouteParams,
  options: VideoApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  const db = options.prismaClient ?? prisma;
  const storage = options.multipartStorage ?? createR2Storage();
  const intent = await loadMultipartUploadIntent(
    db,
    await videoId(params),
    session.creatorId,
  );

  if (!intent) {
    return json({ error: "Upload not found." }, 404);
  }

  if (intent.status === "completed" && intent.videoId) {
    const video = await db.video.findFirst({
      where: {
        id: intent.videoId,
        creatorId: session.creatorId,
      },
      select: {
        id: true,
        pipelineStage: true,
      },
    });

    if (video) {
      return json(
        {
          videoId: video.id,
          stage: video.pipelineStage ?? "uploaded",
          bytes: Number(intent.declaredSizeBytes),
        },
        202,
      );
    }
  }

  if (intent.status !== "uploading" || !intent.uploadId) {
    return json({ error: "Upload is not active." }, 409);
  }

  const uploadedParts = await storage.listSourceUploadParts({
    key: intent.sourceKey,
    uploadId: intent.uploadId,
  });
  const reconciliation = reconcileUploadParts(intent, uploadedParts);
  if (!reconciliation.ok) {
    await failAndAbortMultipartIntent(
      db,
      storage,
      intent,
      reconciliation.error,
      "failed",
    );
    return json({ error: reconciliation.error }, 400);
  }

  await storage.completeSourceMultipartUpload({
    key: intent.sourceKey,
    uploadId: intent.uploadId,
    parts: reconciliation.parts,
  });

  const completed = await createVideoAfterMultipartCompletion(
    db,
    intent,
    session.creatorId,
  );

  startPipelineInBackground(
    completed.videoId,
    completed.runMindOnboarding
      ? options.runFirstVideoOnboardingPipelineImpl ??
          runFirstVideoOnboardingPipeline
      : options.runPipelineImpl ?? runPipeline,
    "upload pipeline",
  );

  return json(
    {
      videoId: completed.videoId,
      stage: completed.runMindOnboarding ? "learning_voice" : "uploaded",
      bytes: reconciliation.bytes,
    },
    202,
  );
}

export async function handleAbortMultipartUpload(
  request: Request,
  params: RouteParams,
  options: VideoApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  const db = options.prismaClient ?? prisma;
  const storage = options.multipartStorage ?? createR2Storage();
  const intent = await loadMultipartUploadIntent(
    db,
    await videoId(params),
    session.creatorId,
  );

  if (!intent) {
    return json({ error: "Upload not found." }, 404);
  }

  if (intent.status === "completed") {
    return json({ error: "Completed uploads cannot be cancelled." }, 409);
  }

  await failAndAbortMultipartIntent(
    db,
    storage,
    intent,
    "Upload cancelled.",
    "aborted",
  );

  return json(
    {
      intentId: intent.id,
      aborted: true,
    },
    200,
  );
}

export async function handleGetVideoStatus(
  request: Request,
  params: RouteParams,
  options: VideoApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  const db = options.prismaClient ?? prisma;
  const video = await db.video.findFirst({
    where: {
      id: await videoId(params),
      creatorId: session.creatorId,
    },
    select: {
      id: true,
      pipelineStage: true,
      pipelineError: true,
      pipelineLeaseHeartbeatAt: true,
      status: true,
      creator: {
        select: {
          mindId: true,
          mindStage: true,
          mindError: true,
          mindLeaseHeartbeatAt: true,
        },
      },
      clips: {
        select: {
          id: true,
        },
      },
    },
  });

  if (!video) {
    return json({ error: "Video not found." }, 404);
  }

  const workflow = normalizedUploadWorkflowStage(video, options.now);

  return json(
    {
      stage: workflow.stage,
      error: workflow.error
        ? publicUploadWorkflowErrorMessage(
            workflow.error,
            workflow.failedStage ?? workflow.stage,
          )
        : null,
      failedStage: workflow.failedStage,
      clipCount: video.clips.length,
    },
    200,
  );
}

export async function handleGetRecentUploads(
  request: Request,
  options: VideoApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  const recentUploads = await loadRecentUploads(session.creatorId, {
    prismaClient: options.prismaClient ?? prisma,
  });

  return json(
    {
      uploads: recentUploads,
    },
    200,
  );
}

export async function handleDeleteVideo(
  request: Request,
  params: RouteParams,
  options: VideoApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  const db = options.prismaClient ?? prisma;
  const id = await videoId(params);
  const video = await db.video.findFirst({
    where: {
      id,
      creatorId: session.creatorId,
    },
    select: {
      id: true,
      sourceKey: true,
      clips: {
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
          status: true,
          renderedUrl: true,
          thumbKey: true,
        },
      },
    },
  });

  if (!video) {
    return json({ error: "Video not found." }, 404);
  }

  if (video.clips.some((clip) => clip.status === "posted")) {
    return postedHistoryResponse();
  }

  try {
    const rowCounts = await db.$transaction(async (tx) => {
      const postedClipCount = await tx.clip.count({
        where: {
          videoId: video.id,
          creatorId: session.creatorId,
          status: "posted",
        },
      });

      if (postedClipCount > 0) {
        throw new PostedHistoryDeleteError();
      }

      const clipIds = video.clips.map((clip) => clip.id);
      const learningEventDelete = await tx.learningEvent.deleteMany({
        where: {
          creatorId: session.creatorId,
          clipId: {
            in: clipIds,
          },
        },
      });
      const clipDelete = await tx.clip.deleteMany({
        where: {
          videoId: video.id,
          creatorId: session.creatorId,
        },
      });
      const videoDelete = await tx.video.deleteMany({
        where: {
          id: video.id,
          creatorId: session.creatorId,
        },
      });

      return {
        learningEvents: learningEventDelete.count,
        clips: clipDelete.count,
        videos: videoDelete.count,
      };
    });
    const deleteTargets = videoDeleteTargets(video);
    const storage = options.deleteStorage ?? createR2Storage();
    await deleteVideoObjectsBestEffort(
      storage,
      deleteTargets,
      options.deleteLogger ?? console,
    );

    return json(
      {
        videoId: video.id,
        deleted: {
          ...rowCounts,
          objects: deleteTargets.length,
        },
      },
      200,
    );
  } catch (error) {
    if (error instanceof PostedHistoryDeleteError) {
      return postedHistoryResponse();
    }

    throw error;
  }
}

export async function handleRetryVideo(
  request: Request,
  params: RouteParams,
  options: VideoApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  const db = options.prismaClient ?? prisma;
  const id = await videoId(params);
  const video = await db.video.findFirst({
    where: {
      id,
      creatorId: session.creatorId,
    },
    select: {
      id: true,
      pipelineStage: true,
      pipelineError: true,
      pipelineLeaseHeartbeatAt: true,
      status: true,
      creator: {
        select: {
          mindId: true,
          mindStage: true,
          mindError: true,
          mindLeaseHeartbeatAt: true,
        },
      },
    },
  });

  if (!video) {
    return json({ error: "Video not found." }, 404);
  }

  if (creatorNeedsMindOnboarding(video.creator)) {
    if (!canRetryMindOnboardingStage(video.creator, options.now)) {
      return json({ error: "Only failed uploads can be retried." }, 409);
    }

    const retryStage = retryableMindOnboardingStage(video.creator);
    await incrementPipelineRetryGeneration(db, video.id);
    startPipelineInBackground(
      video.id,
      options.runFirstVideoOnboardingPipelineImpl ??
        runFirstVideoOnboardingPipeline,
      "Mind onboarding retry",
    );

    return json(
      {
        videoId: video.id,
        retrying: true,
        stage: retryStage,
      },
      202,
    );
  }

  if (!canRetryPipelineStage(video, options.now)) {
    return json({ error: "Only failed uploads can be retried." }, 409);
  }

  const retryStage = retryablePipelineStage(video);
  await incrementPipelineRetryGeneration(db, video.id);
  startPipelineInBackground(
    video.id,
    options.retryPipelineImpl ?? retryPipeline,
    "upload pipeline retry",
  );

  return json(
    {
      videoId: video.id,
      retrying: true,
      stage: retryStage,
    },
    202,
  );
}

async function readMultipartCreateInput(request: Request): Promise<{
  fileName: string | null;
  contentType: string;
  size: number;
}> {
  const body = await readJsonObject(request);
  const size = readUploadSizeValue(body.size);
  if (size <= 0) {
    throw new VideoApiError(400, "Upload file size must be greater than zero.");
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw new VideoApiError(
      413,
      `Video must be ${MAX_UPLOAD_BYTES_LABEL} or smaller.`,
    );
  }

  const contentType = typeof body.contentType === "string" ? body.contentType.trim() : "";
  if (!contentType.toLowerCase().startsWith("video/")) {
    throw new VideoApiError(415, "Upload file must be a video.");
  }

  const rawFileName = typeof body.fileName === "string" ? body.fileName : null;
  return {
    fileName: cleanFileName(rawFileName),
    contentType,
    size,
  };
}

async function readPartNumbers(
  request: Request,
  intent: UploadIntentForMultipart,
): Promise<number[]> {
  const body = await readJsonObject(request);
  if (!Array.isArray(body.partNumbers)) {
    throw new VideoApiError(400, "Part numbers are required.");
  }

  const expectedPartCount = expectedUploadPartCount(intent);
  const seen = new Set<number>();
  const partNumbers: number[] = [];
  for (const value of body.partNumbers) {
    if (!Number.isInteger(value)) {
      throw new VideoApiError(400, "Part numbers must be whole numbers.");
    }
    if (value < 1 || value > expectedPartCount) {
      throw new VideoApiError(400, "Part number is outside this upload.");
    }
    if (!seen.has(value)) {
      seen.add(value);
      partNumbers.push(value);
    }
  }

  if (partNumbers.length === 0) {
    throw new VideoApiError(400, "At least one part number is required.");
  }
  if (partNumbers.length > MAX_SIGNED_UPLOAD_PARTS) {
    throw new VideoApiError(
      400,
      `Sign at most ${MAX_SIGNED_UPLOAD_PARTS} upload parts per request.`,
    );
  }

  return partNumbers;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new VideoApiError(400, "Request body must be JSON.");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new VideoApiError(400, "Request body must be a JSON object.");
  }

  return body as Record<string, unknown>;
}

function readUploadSizeValue(value: unknown): number {
  const size =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new VideoApiError(400, "Upload file size must be a whole number.");
  }

  return size;
}

async function loadMultipartUploadIntent(
  db: PrismaClient,
  intentId: string,
  creatorId: string,
): Promise<UploadIntentForMultipart | null> {
  return db.uploadIntent.findFirst({
    where: {
      id: intentId,
      creatorId,
    },
    select: {
      id: true,
      creatorId: true,
      videoId: true,
      sourceKey: true,
      uploadId: true,
      fileName: true,
      contentType: true,
      declaredSizeBytes: true,
      partSizeBytes: true,
      status: true,
    },
  });
}

async function touchMultipartIntent(
  db: PrismaClient,
  intentId: string,
): Promise<void> {
  await db.uploadIntent.updateMany({
    where: {
      id: intentId,
      status: "uploading",
    },
    data: {
      lastActivityAt: new Date(),
    },
  });
}

function multipartIntentResponse(
  intent: UploadIntentForMultipart,
  args: {
    uploadedParts: SourceUploadPart[];
  },
): {
  intentId: string;
  status: string;
  fileName: string | null;
  size: number;
  partSizeBytes: number;
  uploadedParts: Array<{
    partNumber: number;
    size: number;
  }>;
  videoId: string | null;
} {
  return {
    intentId: intent.id,
    status: intent.status,
    fileName: intent.fileName,
    size: Number(intent.declaredSizeBytes),
    partSizeBytes: intent.partSizeBytes,
    uploadedParts: args.uploadedParts.map((part) => ({
      partNumber: part.partNumber,
      size: part.size,
    })),
    videoId: intent.status === "completed" ? intent.videoId : null,
  };
}

function reconcileUploadParts(
  intent: UploadIntentForMultipart,
  parts: SourceUploadPart[],
):
  | {
      ok: true;
      bytes: number;
      parts: SourceUploadPart[];
    }
  | {
      ok: false;
      error: string;
    } {
  const expectedPartCount = expectedUploadPartCount(intent);
  const expectedBytes = Number(intent.declaredSizeBytes);
  const byPartNumber = new Map<number, SourceUploadPart>();

  for (const part of parts) {
    if (byPartNumber.has(part.partNumber)) {
      return {
        ok: false,
        error: "Upload contains duplicate parts.",
      };
    }
    byPartNumber.set(part.partNumber, part);
  }

  const orderedParts: SourceUploadPart[] = [];
  let totalBytes = 0;
  for (let partNumber = 1; partNumber <= expectedPartCount; partNumber += 1) {
    const part = byPartNumber.get(partNumber);
    if (!part) {
      return {
        ok: false,
        error: "Upload is missing one or more parts.",
      };
    }

    const expectedSize = expectedUploadPartSize(intent, partNumber);
    if (part.size !== expectedSize) {
      return {
        ok: false,
        error: "Uploaded part bytes do not match the declared file size.",
      };
    }
    if (partNumber < expectedPartCount && part.size < MIN_MULTIPART_PART_BYTES) {
      return {
        ok: false,
        error: "Uploaded parts are smaller than the multipart minimum.",
      };
    }
    if (!part.etag.trim()) {
      return {
        ok: false,
        error: "Upload part is missing its R2 checksum.",
      };
    }

    orderedParts.push(part);
    totalBytes += part.size;
  }

  if (byPartNumber.size !== expectedPartCount || totalBytes !== expectedBytes) {
    return {
      ok: false,
      error: "Uploaded bytes do not match the declared file size.",
    };
  }

  return {
    ok: true,
    bytes: totalBytes,
    parts: orderedParts,
  };
}

function expectedUploadPartCount(intent: UploadIntentForMultipart): number {
  return Math.ceil(Number(intent.declaredSizeBytes) / intent.partSizeBytes);
}

function expectedUploadPartSize(
  intent: UploadIntentForMultipart,
  partNumber: number,
): number {
  const declaredSize = Number(intent.declaredSizeBytes);
  const fullParts = Math.floor(declaredSize / intent.partSizeBytes);
  const lastPartSize = declaredSize % intent.partSizeBytes;
  const expectedPartCount = expectedUploadPartCount(intent);

  if (partNumber < expectedPartCount || lastPartSize === 0) {
    return intent.partSizeBytes;
  }

  if (partNumber === fullParts + 1) {
    return lastPartSize;
  }

  return intent.partSizeBytes;
}

async function failAndAbortMultipartIntent(
  db: PrismaClient,
  storage: MultipartUploadStorage,
  intent: UploadIntentForMultipart,
  reason: string,
  status: "aborted" | "failed",
): Promise<void> {
  if (intent.uploadId) {
    await storage.abortSourceMultipartUpload({
      key: intent.sourceKey,
      uploadId: intent.uploadId,
    });
  }
  await storage.deleteSource(intent.sourceKey);

  const now = new Date();
  await db.uploadIntent.updateMany({
    where: {
      id: intent.id,
      status: {
        not: "completed",
      },
    },
    data: {
      status,
      failureReason: reason,
      abortedAt: now,
      lastActivityAt: now,
    },
  });
}

async function createVideoAfterMultipartCompletion(
  db: PrismaClient,
  intent: UploadIntentForMultipart,
  creatorId: string,
): Promise<{
  videoId: string;
  runMindOnboarding: boolean;
}> {
  const now = new Date();
  return db.$transaction(async (tx) => {
    const creator = await tx.creator.findUniqueOrThrow({
      where: {
        id: creatorId,
      },
      select: {
        mindId: true,
        mindStage: true,
      },
    });
    const runMindOnboarding = creatorNeedsMindOnboarding(creator);
    const videoId = intent.videoId ?? randomUUID();
    const video = await tx.video.create({
      data: {
        id: videoId,
        creatorId,
        sourceKey: intent.sourceKey,
        contentKey: `uploaded:${creatorId}:${videoId}`,
        status: "uploaded",
        pipelineStage: "uploaded",
        pipelineError: null,
        pipelineRunId: runMindOnboarding ? null : newWorkflowRunId("pipeline"),
        pipelineLeaseHeartbeatAt: runMindOnboarding ? null : now,
      },
      select: {
        id: true,
      },
    });

    await tx.uploadIntent.update({
      where: {
        id: intent.id,
      },
      data: {
        videoId: video.id,
        status: "completed",
        failureReason: null,
        completedAt: now,
        lastActivityAt: now,
      },
    });

    if (runMindOnboarding) {
      await tx.creator.update({
        where: {
          id: creatorId,
        },
        data: {
          mindStage: "learning_voice",
          mindError: null,
          mindRunId: newWorkflowRunId("mind-onboarding"),
          mindLeaseHeartbeatAt: now,
        },
      });
    }

    return {
      videoId: video.id,
      runMindOnboarding,
    };
  });
}

function cleanFileName(value: string | null): string | null {
  const clean = value?.trim().replace(/\s+/g, " ");
  if (!clean) {
    return null;
  }

  return clean.slice(0, 255);
}

function cappedErrorMessage(error: unknown): string {
  return errorMessage(error).slice(0, 500);
}

function assertUploadRequest(request: Request): number {
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    throw new VideoApiError(400, "Upload must be multipart form data.");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_UPLOAD_BYTES) {
      throw new VideoApiError(
        413,
        `Video must be ${MAX_UPLOAD_BYTES_LABEL} or smaller.`,
      );
    }
  }

  const fileSize = readUploadFileSize(request);
  if (fileSize > MAX_UPLOAD_BYTES) {
    throw new VideoApiError(
      413,
      `Video must be ${MAX_UPLOAD_BYTES_LABEL} or smaller.`,
    );
  }

  if (!request.body) {
    throw new VideoApiError(400, "Upload body is required.");
  }

  return fileSize;
}

function streamMultipartVideoToStorage(
  request: Request,
  videoId: string,
  storage: Pick<R2Storage, "uploadSource">,
  fileSize: number,
): Promise<UploadedFile> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let fileSeen = false;
    let invalidFile = false;
    let fileTooLarge = false;
    let tooManyFiles = false;
    let uploadError: unknown = null;
    let uploadPromise: Promise<string> | null = null;
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    const parser = busboy({
      headers: headersObject(request.headers),
      limits: {
        files: 1,
        fileSize: MAX_UPLOAD_BYTES,
        fields: 8,
      },
    });

    parser.on("file", (fieldName, file, info) => {
      if (fileSeen) {
        tooManyFiles = true;
        file.resume();
        return;
      }

      fileSeen = true;
      const mimeType = info.mimeType?.toLowerCase() ?? "";
      if (fieldName !== "file" || !mimeType.startsWith("video/")) {
        invalidFile = true;
        file.resume();
        return;
      }

      file.on("limit", () => {
        fileTooLarge = true;
      });

      const meteredFile = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(null, chunk);
        },
      });
      file.on("error", (error) => {
        meteredFile.destroy(error);
      });
      file.pipe(meteredFile);

      uploadPromise = storage
        .uploadSource(videoId, meteredFile as StorageUploadBody, {
          contentLength: fileSize,
        })
        .catch((error: unknown) => {
          uploadError = error;
          return "";
        });
    });

    parser.on("filesLimit", () => {
      tooManyFiles = true;
    });
    parser.on("error", fail);
    parser.on("finish", () => {
      void finishUpload();
    });

    async function finishUpload() {
      if (settled) {
        return;
      }

      try {
        if (!fileSeen) {
          throw new VideoApiError(400, "Upload must include a video file.");
        }
        if (tooManyFiles) {
          throw new VideoApiError(400, "Upload accepts one video file.");
        }
        if (invalidFile) {
          throw new VideoApiError(415, "Upload file must be a video.");
        }
        if (fileTooLarge) {
          throw new VideoApiError(
            413,
            `Video must be ${MAX_UPLOAD_BYTES_LABEL} or smaller.`,
          );
        }
        if (!uploadPromise) {
          throw new VideoApiError(400, "Upload must include a video file.");
        }

        const sourceKey = await uploadPromise;
        if (uploadError) {
          throw uploadError;
        }
        if (!sourceKey) {
          throw new Error("R2 upload did not return a source key.");
        }

        settled = true;
        resolve({
          sourceKey,
          bytes,
        });
      } catch (error) {
        fail(error);
      }
    }

    const source = Readable.fromWeb(
      request.body as Parameters<typeof Readable.fromWeb>[0],
    );
    source.on("error", fail);
    source.pipe(parser);
  });
}

function readUploadFileSize(request: Request): number {
  const rawValue = request.headers.get("x-clipmind-file-size");
  if (!rawValue) {
    throw new VideoApiError(400, "Upload file size is required.");
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0) {
    throw new VideoApiError(400, "Upload file size must be a whole number.");
  }

  return value;
}

function startPipelineInBackground(
  videoId: string,
  run: (videoId: string) => Promise<BackgroundRunResult>,
  label: string,
): void {
  void run(videoId)
    .then((result) => {
      if (result.status === "failed") {
        console.error(`${label} failed for ${videoId}: ${result.error}`);
      }
    })
    .catch((error: unknown) => {
      console.error(`${label} crashed for ${videoId}: ${errorMessage(error)}`);
    });
}

async function incrementPipelineRetryGeneration(
  db: PrismaClient,
  videoId: string,
): Promise<void> {
  await db.video.update({
    where: {
      id: videoId,
    },
    data: {
      pipelineRetryGeneration: {
        increment: 1,
      },
    },
  });
}

async function loadCreatorSession(
  request: Request,
  options: VideoApiOptions,
) {
  return loadCreatorSessionFromCookieHeader(
    request.headers.get("cookie"),
    options,
  );
}

async function videoId(params: RouteParams): Promise<string> {
  return (await params).id;
}

function normalizedPipelineStage(
  pipelineStage: string | null,
  legacyStatus: string,
): PipelineStage {
  if (PIPELINE_STAGES.includes(pipelineStage as PipelineStage)) {
    return pipelineStage as PipelineStage;
  }

  switch (legacyStatus) {
    case "clipped":
      return "done";
    case "transcribed":
      return "candidates";
    default:
      return "uploaded";
  }
}

function retryablePipelineStage(video: {
  pipelineStage: string | null;
  pipelineError: string | null;
  status: string;
}): UploadWorkflowStage {
  if (video.pipelineStage === "failed") {
    return failedPipelineStage(video.pipelineError);
  }

  return normalizedPipelineStage(video.pipelineStage, video.status);
}

function retryableMindOnboardingStage(creator: {
  mindStage: string | null;
  mindError: string | null;
}): MindOnboardingStage {
  if (creator.mindStage === "failed") {
    return failedMindOnboardingStage(creator.mindError);
  }
  if (isMindOnboardingStage(creator.mindStage)) {
    return creator.mindStage;
  }

  return "learning_voice";
}

function normalizedUploadWorkflowStage(video: {
  pipelineStage: string | null;
  pipelineError: string | null;
  pipelineLeaseHeartbeatAt: Date | null;
  status: string;
  creator: {
    mindId: string | null;
    mindStage: string | null;
    mindError: string | null;
    mindLeaseHeartbeatAt: Date | null;
  };
}, now: Date = new Date()): {
  stage: UploadWorkflowStage;
  error: string | null;
  failedStage: UploadWorkflowStage | null;
} {
  if (creatorNeedsMindOnboarding(video.creator)) {
    if (video.creator.mindStage === "failed") {
      return {
        stage: "failed",
        error: video.creator.mindError,
        failedStage: failedMindOnboardingStage(video.creator.mindError),
      };
    }

    if (isMindOnboardingStage(video.creator.mindStage)) {
      if (canRetryMindOnboardingStage(video.creator, now)) {
        return {
          stage: "failed",
          error: workflowLeaseExpiredError(video.creator.mindStage),
          failedStage: video.creator.mindStage,
        };
      }

      return {
        stage: video.creator.mindStage,
        error: null,
        failedStage: null,
      };
    }

    return {
      stage: "learning_voice",
      error: null,
      failedStage: null,
    };
  }

  const stage = normalizedPipelineStage(video.pipelineStage, video.status);
  if (stage !== "done" && canRetryPipelineStage(video, now)) {
    if (video.pipelineStage === "failed") {
      return {
        stage,
        error: video.pipelineError,
        failedStage: failedPipelineStage(video.pipelineError),
      };
    }

    return {
      stage: "failed",
      error: workflowLeaseExpiredError(stage),
      failedStage: stage,
    };
  }

  return {
    stage,
    error: video.pipelineError,
    failedStage:
      stage === "failed" ? failedPipelineStage(video.pipelineError) : null,
  };
}

function videoDeleteTargets(video: {
  sourceKey: string | null;
  clips: Array<{
    renderedUrl: string | null;
    thumbKey: string | null;
  }>;
}): Array<{ bucket: "sources" | "media"; key: string }> {
  const targets: Array<{ bucket: "sources" | "media"; key: string }> = [];
  const sourceKey = video.sourceKey?.trim();
  if (sourceKey) {
    targets.push({
      bucket: "sources",
      key: sourceKey,
    });
  }

  for (const clip of video.clips) {
    const renderedKey = publicMediaKeyFromUrl(clip.renderedUrl);
    if (renderedKey) {
      targets.push({
        bucket: "media",
        key: renderedKey,
      });
    }

    const thumbKey = clip.thumbKey?.trim();
    if (thumbKey) {
      targets.push({
        bucket: "media",
        key: thumbKey,
      });
    }
  }

  return targets;
}

async function deleteVideoObjectsBestEffort(
  storage: VideoDeleteStorage,
  targets: Array<{ bucket: "sources" | "media"; key: string }>,
  logger: Pick<Console, "error">,
): Promise<void> {
  for (const target of targets) {
    try {
      if (target.bucket === "sources") {
        await storage.deleteSource(target.key);
      } else {
        await storage.deleteMediaObject(target.key);
      }
    } catch (error) {
      logger.error(
        [
          "Video R2 delete failed",
          `bucket=${target.bucket}`,
          `key=${target.key}`,
          `error=${errorMessage(error)}`,
        ].join(" "),
      );
    }
  }
}

function headersObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

function json(payload: unknown, status: number): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function postedHistoryResponse(): Response {
  return json(
    {
      reason: "posted history",
      error: POSTED_HISTORY_DELETE_MESSAGE,
    },
    409,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
