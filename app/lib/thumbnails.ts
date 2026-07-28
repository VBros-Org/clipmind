import type { PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import { env } from "./env";
import {
  createR2Storage,
  publicMediaUrlForKey,
  type R2Storage,
} from "./storage";

export type GenerateClipThumbnailResult =
  | {
      status: "generated";
      clipId: string;
      videoId: string;
      thumbKey: string;
      thumbUrl: string | null;
    }
  | {
      status: "exists";
      clipId: string;
      videoId: string;
      thumbKey: string;
      thumbUrl: string | null;
    }
  | {
      status: "skipped";
      clipId: string;
      videoId: string;
      reason: "missing_source_key";
    };

export type ThumbnailFetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type GenerateClipThumbnailOptions = {
  fetchImpl?: ThumbnailFetchLike;
  force?: boolean;
  prismaClient?: PrismaClient;
  storage?: Pick<R2Storage, "presignSourceUrl" | "uploadThumbnail">;
};

export async function generateClipThumbnail(
  clipId: string,
  options: GenerateClipThumbnailOptions = {},
): Promise<GenerateClipThumbnailResult> {
  const db = options.prismaClient ?? prisma;
  const storage = options.storage ?? createR2Storage();
  const fetchImpl = options.fetchImpl ?? fetch;

  const clip = await db.clip.findUnique({
    where: {
      id: clipId,
    },
    select: {
      id: true,
      videoId: true,
      startMs: true,
      thumbKey: true,
      video: {
        select: {
          sourceKey: true,
        },
      },
    },
  });

  if (!clip) {
    throw new Error(`Clip ${clipId} does not exist.`);
  }

  if (clip.thumbKey && !options.force) {
    return {
      status: "exists",
      clipId: clip.id,
      videoId: clip.videoId,
      thumbKey: clip.thumbKey,
      thumbUrl: publicMediaUrlForKey(clip.thumbKey),
    };
  }

  if (!clip.video.sourceKey) {
    return {
      status: "skipped",
      clipId: clip.id,
      videoId: clip.videoId,
      reason: "missing_source_key",
    };
  }

  const sourceUrl = await storage.presignSourceUrl(clip.video.sourceKey);
  const response = await fetchImpl(clipServiceThumbnailEndpoint().toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLIP_SERVICE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source_url: sourceUrl,
      timestamp_ms: clip.startMs,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Clip service /thumbnail failed with ${response.status}: ${detail.slice(0, 500)}`,
    );
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0) {
    throw new Error("Clip service /thumbnail returned an empty response body.");
  }

  const thumbKey = await storage.uploadThumbnail(clip.id, body);
  await db.clip.update({
    where: {
      id: clip.id,
    },
    data: {
      thumbKey,
    },
  });

  return {
    status: "generated",
    clipId: clip.id,
    videoId: clip.videoId,
    thumbKey,
    thumbUrl: publicMediaUrlForKey(thumbKey),
  };
}

function clipServiceThumbnailEndpoint(): URL {
  const base = env.CLIP_SERVICE_URL.endsWith("/")
    ? env.CLIP_SERVICE_URL
    : `${env.CLIP_SERVICE_URL}/`;
  return new URL("thumbnail", base);
}
