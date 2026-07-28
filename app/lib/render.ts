import type { PrismaClient } from "@prisma/client";

import { prisma } from "./db";
import { env } from "./env";
import {
  createR2Storage,
  type R2Storage,
  type StorageUploadBody,
} from "./storage";

export type RenderClipResult = {
  clipId: string;
  videoId: string;
  renderedUrl: string;
};

export type RenderFetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type RenderClipOptions = {
  fetchImpl?: RenderFetchLike;
  prismaClient?: PrismaClient;
  storage?: Pick<R2Storage, "presignSourceUrl" | "uploadRender">;
};

export async function renderClip(
  clipId: string,
  presetId: string,
  options: RenderClipOptions = {},
): Promise<RenderClipResult> {
  const db = options.prismaClient ?? prisma;
  const storage = options.storage ?? createR2Storage();
  const fetchImpl = options.fetchImpl ?? fetch;

  const clip = await db.clip.findUnique({
    where: {
      id: clipId,
    },
    include: {
      video: {
        select: {
          id: true,
          sourceKey: true,
        },
      },
    },
  });

  if (!clip) {
    throw new Error(`Clip ${clipId} does not exist.`);
  }
  if (!clip.video.sourceKey) {
    throw new Error(`Video ${clip.videoId} has no sourceKey for rendering.`);
  }

  const sourceUrl = await storage.presignSourceUrl(clip.video.sourceKey);
  const response = await fetchImpl(clipServiceCutEndpoint().toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLIP_SERVICE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source_url: sourceUrl,
      start_ms: clip.startMs,
      end_ms: clip.endMs,
      trim_start_ms: clip.trimStartMs ?? 0,
      trim_end_ms: clip.trimEndMs ?? 0,
      preset_id: presetId,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Clip service /cut failed with ${response.status}: ${detail.slice(0, 500)}`,
    );
  }
  if (!response.body) {
    throw new Error("Clip service /cut returned an empty response body.");
  }

  const renderedUrl = await storage.uploadRender(
    clip.id,
    await responseBodyToUploadBody(response.body),
  );

  await db.clip.update({
    where: {
      id: clip.id,
    },
    data: {
      renderedUrl,
    },
  });

  return {
    clipId: clip.id,
    videoId: clip.videoId,
    renderedUrl,
  };
}

function clipServiceCutEndpoint(): URL {
  const base = env.CLIP_SERVICE_URL.endsWith("/")
    ? env.CLIP_SERVICE_URL
    : `${env.CLIP_SERVICE_URL}/`;
  return new URL("cut", base);
}

async function responseBodyToUploadBody(
  body: ReadableStream<Uint8Array>,
): Promise<StorageUploadBody> {
  return Buffer.from(await new Response(body).arrayBuffer());
}
