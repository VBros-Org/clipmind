import { basename } from "node:path";
import { readFile } from "node:fs/promises";

import { CORPUS_WEIGHTS, type CorpusSourceType } from "./prompts/voice-distill";
import { parseTranscript, type Transcript } from "./transcript";

export interface CorpusItem {
  source: string;
  sourceType: CorpusSourceType;
  weight: number;
}

export interface ClipServiceConfig {
  url: string;
  token: string;
}

export type ChannelVideo = {
  videoId: string;
  title: string;
  durationS: number | null;
  url: string;
};

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "text" | "json">>;

export class ClipServiceApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

export function makeCorpusItem(
  source: string,
  sourceType: CorpusSourceType = "source_video",
): CorpusItem {
  const cleanSource = source.trim();
  if (!cleanSource) {
    throw new Error("Corpus source cannot be empty.");
  }

  return {
    source: cleanSource,
    sourceType,
    weight: CORPUS_WEIGHTS[sourceType],
  };
}

export function clipServiceConfigFromEnv(env = process.env): ClipServiceConfig {
  const url = env.CLIP_SERVICE_URL?.trim();
  const token = env.CLIP_SERVICE_TOKEN?.trim();

  if (!url) {
    throw new Error("CLIP_SERVICE_URL is required for onboarding.");
  }
  if (!token) {
    throw new Error("CLIP_SERVICE_TOKEN is required for onboarding.");
  }

  return { url, token };
}

export function createClipServiceTranscriber(
  config: ClipServiceConfig,
  fetchImpl: FetchLike = fetch,
): (item: CorpusItem) => Promise<Transcript> {
  return (item) => transcribeWithClipService(item, config, fetchImpl);
}

export async function transcribeWithClipService(
  item: CorpusItem,
  config: ClipServiceConfig,
  fetchImpl: FetchLike = fetch,
): Promise<Transcript> {
  const endpoint = `${config.url.replace(/\/$/, "")}/transcribe`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
  };

  let body: RequestInit["body"];
  if (isHttpUrl(item.source)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ source_url: item.source });
  } else {
    const form = new FormData();
    const data = await readFile(item.source);
    form.set("file", new Blob([data]), basename(item.source));
    body = form;
  }

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    throw await clipServiceError(response, "/transcribe");
  }

  return parseTranscript(await response.json());
}

export async function listChannelWithClipService(
  channelUrl: string,
  config: ClipServiceConfig,
  fetchImpl: FetchLike = fetch,
): Promise<ChannelVideo[]> {
  const endpoint = `${config.url.replace(/\/$/, "")}/channel-list`;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel_url: channelUrl,
    }),
  });

  if (!response.ok) {
    throw await clipServiceError(response, "/channel-list");
  }

  return parseChannelListResponse(await response.json());
}

export async function transcribeRemoteWithClipService(
  videoUrl: string,
  maxDurationS: number,
  config: ClipServiceConfig,
  fetchImpl: FetchLike = fetch,
): Promise<Transcript> {
  const endpoint = `${config.url.replace(/\/$/, "")}/transcribe-remote`;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      video_url: videoUrl,
      max_duration_s: maxDurationS,
    }),
  });

  if (!response.ok) {
    throw await clipServiceError(response, "/transcribe-remote");
  }

  return parseTranscript(await response.json());
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseChannelListResponse(payload: unknown): ChannelVideo[] {
  if (!isRecord(payload) || !Array.isArray(payload.videos)) {
    throw new Error("Clip service /channel-list response must include videos.");
  }

  return payload.videos.map(parseChannelVideo);
}

function parseChannelVideo(payload: unknown): ChannelVideo {
  if (!isRecord(payload)) {
    throw new Error("Clip service channel video must be an object.");
  }

  const videoId = textField(payload, "video_id");
  const title = textField(payload, "title");
  const url = textField(payload, "url");
  const rawDuration = payload.duration_s;
  if (
    rawDuration !== null &&
    rawDuration !== undefined &&
    (typeof rawDuration !== "number" || !Number.isFinite(rawDuration))
  ) {
    throw new Error("Clip service channel video duration_s must be a number.");
  }

  return {
    videoId,
    title,
    durationS: rawDuration === null || rawDuration === undefined ? null : rawDuration,
    url,
  };
}

async function clipServiceError(
  response: Pick<Response, "status" | "text">,
  path: string,
): Promise<ClipServiceApiError> {
  const detail = await response.text();
  const parsed = parseErrorDetail(detail);
  return new ClipServiceApiError(
    response.status,
    `Clip service ${path} failed with ${response.status}: ${parsed.message}`,
    parsed.code,
  );
}

function parseErrorDetail(value: string): { code: string | null; message: string } {
  try {
    const payload = JSON.parse(value) as unknown;
    const detail = isRecord(payload) ? payload.detail : null;
    if (isRecord(detail)) {
      return {
        code: typeof detail.code === "string" ? detail.code : null,
        message:
          typeof detail.message === "string"
            ? detail.message
            : JSON.stringify(detail).slice(0, 500),
      };
    }
    if (typeof detail === "string") {
      return {
        code: null,
        message: detail,
      };
    }
    if (isRecord(payload) && typeof payload.error === "string") {
      return {
        code: typeof payload.code === "string" ? payload.code : null,
        message: payload.error,
      };
    }
  } catch {
    // Fall through to the raw bounded detail below.
  }

  return {
    code: null,
    message: value.slice(0, 500),
  };
}

function textField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Clip service channel video ${key} must be text.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
