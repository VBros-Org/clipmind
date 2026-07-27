import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import { env } from "./env";

type VideoStatus = "uploaded" | "transcribed" | "clipped";

type ResolvedSource =
  | {
      kind: "file";
      contentKey: string;
      path: string;
      sourceUrl: null;
    }
  | {
      kind: "url";
      contentKey: string;
      sourceUrl: string;
    };

type ClipServiceSource =
  | {
      kind: "file";
      path: string;
    }
  | {
      kind: "url";
      sourceUrl: string;
    };

export type ClipServiceCandidate = {
  startMs: number;
  endMs: number;
  transcript: string | null;
  reasons: Prisma.JsonValue | null;
};

export type ClipServiceCandidateResponse = {
  candidates: ClipServiceCandidate[];
};

export interface ClipServiceClient {
  fetchCandidates(source: ClipServiceSource): Promise<ClipServiceCandidateResponse>;
}

type IngestVideoOptions = {
  clipServiceClient?: ClipServiceClient;
  prismaClient?: PrismaClient;
};

export type IngestVideoResult = {
  videoId: string;
  contentKey: string;
  status: VideoStatus;
  clipCount: number;
  createdClipCount: number;
  createdVideo: boolean;
  skippedExisting: boolean;
};

const defaultClipServiceClient: ClipServiceClient = {
  async fetchCandidates(source: ClipServiceSource): Promise<ClipServiceCandidateResponse> {
    const endpoint = clipServiceEndpoint();
    const response =
      source.kind === "file"
        ? await fetchMultipartCandidates(endpoint, source.path)
        : await fetchUrlCandidates(endpoint, source.sourceUrl);

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Clip service /candidates failed with ${response.status}: ${detail.slice(0, 500)}`,
      );
    }

    return parseClipServiceResponse(await response.json());
  },
};

// Idempotency: re-ingesting an already clipped source returns the existing Video
// and Clip rows. It does not call the clip service or create duplicate clips.
export async function ingestVideo(
  creatorId: string,
  source: string,
  options: IngestVideoOptions = {},
): Promise<IngestVideoResult> {
  const db = options.prismaClient ?? prisma;
  const clipServiceClient = options.clipServiceClient ?? defaultClipServiceClient;
  const resolvedSource = await resolveSource(creatorId, source);

  const creator = await db.creator.findUnique({
    where: {
      id: creatorId,
    },
    select: {
      id: true,
    },
  });

  if (!creator) {
    throw new Error(`Creator ${creatorId} does not exist.`);
  }

  const existingVideo = await db.video.findUnique({
    where: {
      contentKey: resolvedSource.contentKey,
    },
    select: {
      id: true,
      status: true,
    },
  });

  if (existingVideo?.status === "clipped") {
    const clipCount = await db.clip.count({
      where: {
        videoId: existingVideo.id,
      },
    });

    return {
      videoId: existingVideo.id,
      contentKey: resolvedSource.contentKey,
      status: "clipped",
      clipCount,
      createdClipCount: 0,
      createdVideo: false,
      skippedExisting: true,
    };
  }

  const video =
    existingVideo ??
    (await db.video.create({
      data: {
        creatorId,
        contentKey: resolvedSource.contentKey,
        sourceUrl: resolvedSource.sourceUrl,
        status: "uploaded",
      },
      select: {
        id: true,
        status: true,
      },
    }));

  if (existingVideo) {
    await db.video.update({
      where: {
        id: video.id,
      },
      data: {
        status: "uploaded",
        sourceUrl: resolvedSource.sourceUrl,
      },
    });

    await db.clip.deleteMany({
      where: {
        videoId: video.id,
        status: "candidate",
      },
    });
  }

  const candidateResponse = await clipServiceClient.fetchCandidates(
    toClipServiceSource(resolvedSource),
  );

  await db.video.update({
    where: {
      id: video.id,
    },
    data: {
      status: "transcribed",
    },
  });

  await db.$transaction(async (tx) => {
    await tx.clip.deleteMany({
      where: {
        videoId: video.id,
        status: "candidate",
      },
    });

    for (const candidate of candidateResponse.candidates) {
      await tx.clip.create({
        data: {
          videoId: video.id,
          creatorId,
          startMs: candidate.startMs,
          endMs: candidate.endMs,
          transcript: candidate.transcript,
          reasons: candidate.reasons === null ? undefined : candidate.reasons,
          status: "candidate",
        },
      });
    }

    await tx.video.update({
      where: {
        id: video.id,
      },
      data: {
        status: "clipped",
      },
    });
  });

  const clipCount = await db.clip.count({
    where: {
      videoId: video.id,
    },
  });

  return {
    videoId: video.id,
    contentKey: resolvedSource.contentKey,
    status: "clipped",
    clipCount,
    createdClipCount: candidateResponse.candidates.length,
    createdVideo: !existingVideo,
    skippedExisting: false,
  };
}

async function fetchMultipartCandidates(endpoint: URL, filePath: string): Promise<Response> {
  const body = new FormData();
  const blob = await openAsBlob(filePath);
  body.append("file", blob, path.basename(filePath));

  return fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLIP_SERVICE_TOKEN}`,
    },
    body,
  });
}

function fetchUrlCandidates(endpoint: URL, sourceUrl: string): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLIP_SERVICE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source_url: sourceUrl,
    }),
  });
}

function clipServiceEndpoint(): URL {
  const base = env.CLIP_SERVICE_URL.endsWith("/")
    ? env.CLIP_SERVICE_URL
    : `${env.CLIP_SERVICE_URL}/`;
  return new URL("candidates", base);
}

function parseClipServiceResponse(payload: unknown): ClipServiceCandidateResponse {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
    throw new Error("Clip service response must include a candidates array.");
  }

  return {
    candidates: payload.candidates.map(parseClipServiceCandidate),
  };
}

function parseClipServiceCandidate(payload: unknown): ClipServiceCandidate {
  if (!isRecord(payload)) {
    throw new Error("Clip service candidate must be an object.");
  }

  const startMs = readRequiredInteger(payload, "start_ms", "startMs");
  const endMs = readRequiredInteger(payload, "end_ms", "endMs");

  if (startMs < 0 || endMs <= startMs) {
    throw new Error(`Invalid clip candidate window ${startMs}-${endMs}.`);
  }

  return {
    startMs,
    endMs,
    transcript: typeof payload.transcript === "string" ? payload.transcript : null,
    reasons: toJsonValue(payload.reasons),
  };
}

function readRequiredInteger(
  payload: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): number {
  const value = payload[snakeKey] ?? payload[camelKey];

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Clip service candidate field ${snakeKey} must be an integer.`);
  }

  return value;
}

function toJsonValue(value: unknown): Prisma.JsonValue | null {
  if (value === undefined || value === null) {
    return null;
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.JsonValue;
}

async function resolveSource(creatorId: string, source: string): Promise<ResolvedSource> {
  const trimmed = source.trim();

  if (!trimmed) {
    throw new Error("Video source is required.");
  }

  const url = parseUrl(trimmed);

  if (url?.protocol === "http:" || url?.protocol === "https:") {
    const normalizedUrl = normalizeHttpUrl(url);
    return {
      kind: "url",
      contentKey: contentKeyFor(creatorId, "url", normalizedUrl),
      sourceUrl: normalizedUrl,
    };
  }

  const filePath = url?.protocol === "file:" ? fileURLToPath(url) : trimmed;
  const resolvedPath = await resolveFilePath(filePath);
  const fileDigest = await sha256File(resolvedPath);

  return {
    kind: "file",
    contentKey: contentKeyFor(creatorId, "file", fileDigest),
    path: resolvedPath,
    sourceUrl: null,
  };
}

async function resolveFilePath(sourcePath: string): Promise<string> {
  const resolvedPath = await realpath(path.resolve(sourcePath));
  const fileStat = await stat(resolvedPath);

  if (!fileStat.isFile()) {
    throw new Error(`Video source is not a file: ${sourcePath}`);
  }

  return resolvedPath;
}

function parseUrl(source: string): URL | null {
  try {
    return new URL(source);
  } catch {
    return null;
  }
}

function normalizeHttpUrl(url: URL): string {
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.searchParams.sort();
  return url.toString();
}

function toClipServiceSource(source: ResolvedSource): ClipServiceSource {
  if (source.kind === "file") {
    return {
      kind: "file",
      path: source.path,
    };
  }

  return {
    kind: "url",
    sourceUrl: source.sourceUrl,
  };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  return hash.digest("hex");
}

function contentKeyFor(creatorId: string, sourceKind: "file" | "url", sourceKey: string): string {
  const hash = createHash("sha256");
  hash.update(creatorId);
  hash.update("\0");
  hash.update(sourceKind);
  hash.update("\0");
  hash.update(sourceKey);
  return `sha256:${hash.digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
