import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";

import busboy from "busboy";
import type { PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import { loadRecentUploads } from "./app-overview";
import {
  PIPELINE_STAGES,
  failedPipelineStage,
  retryPipeline,
  runPipeline,
  type PipelineRunResult,
  type PipelineStage,
} from "./pipeline";
import { loadCreatorSessionFromCookieHeader } from "./review-auth";
import {
  createR2Storage,
  type R2Storage,
  type StorageUploadBody,
} from "./storage";
import {
  creatorNeedsMindOnboarding,
  failedMindOnboardingStage,
  isMindOnboardingStage,
  runFirstVideoOnboardingPipeline,
  type FirstVideoOnboardingResult,
  type MindOnboardingStage,
} from "./video-onboarding";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_UPLOAD_BYTES_LABEL = "2 GB";

type RouteParams = { id: string } | Promise<{ id: string }>;
type UploadWorkflowStage = PipelineStage | MindOnboardingStage;
type BackgroundRunResult = PipelineRunResult | FirstVideoOnboardingResult;

export type VideoApiOptions = {
  prismaClient?: PrismaClient;
  storage?: Pick<R2Storage, "uploadSource">;
  runPipelineImpl?: (videoId: string) => Promise<BackgroundRunResult>;
  retryPipelineImpl?: (videoId: string) => Promise<BackgroundRunResult>;
  runFirstVideoOnboardingPipelineImpl?: (
    videoId: string,
  ) => Promise<BackgroundRunResult>;
};

type UploadedFile = {
  sourceKey: string;
  bytes: number;
};

class VideoApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
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
      status: true,
      creator: {
        select: {
          mindId: true,
          mindStage: true,
          mindError: true,
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

  const workflow = normalizedUploadWorkflowStage(video);

  return json(
    {
      stage: workflow.stage,
      error: workflow.error,
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
      creator: {
        select: {
          mindId: true,
          mindStage: true,
          mindError: true,
        },
      },
    },
  });

  if (!video) {
    return json({ error: "Video not found." }, 404);
  }

  if (creatorNeedsMindOnboarding(video.creator)) {
    if (video.creator.mindStage !== "failed") {
      return json({ error: "Only failed uploads can be retried." }, 409);
    }

    const retryStage = failedMindOnboardingStage(video.creator.mindError);
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

  if (video.pipelineStage !== "failed") {
    return json({ error: "Only failed uploads can be retried." }, 409);
  }

  const retryStage = failedPipelineStage(video.pipelineError);
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

function normalizedUploadWorkflowStage(video: {
  pipelineStage: string | null;
  pipelineError: string | null;
  status: string;
  creator: {
    mindId: string | null;
    mindStage: string | null;
    mindError: string | null;
  };
}): {
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
  return {
    stage,
    error: video.pipelineError,
    failedStage:
      stage === "failed" ? failedPipelineStage(video.pipelineError) : null,
  };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
