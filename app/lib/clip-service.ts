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

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "text" | "json">>;

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
    const detail = await response.text();
    throw new Error(
      `Clip service /transcribe failed with ${response.status}: ${detail}`,
    );
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
