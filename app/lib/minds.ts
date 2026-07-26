import type { BuilderMind } from "@animocabrands/minds-client-lib";

import type { InitialTenets } from "./tenets";

export const MINDS_BUILDER_API_KEY_ENV = "MINDS_BUILDER_API_KEY";
export const MINDS_BUILDER_API_KEY_HEADER = "X-Api-Key";
export const MINDS_BUILDER_API_BASE_URL = "https://api.build.hellominds.ai";
export const MINDS_CREATION_SKIPPED_MESSAGE =
  "MINDS_BUILDER_API_KEY not set, Mind creation skipped";

export interface MindCreationResult {
  mindId: string;
}

export interface MindsClient {
  createMind(name: string): Promise<MindCreationResult>;
  addTenets(mindId: string, tenets: InitialTenets): Promise<void>;
}

export type MindsFetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "text" | "json">>;

export function createMindsClientFromEnv(
  env = process.env,
  fetchImpl: MindsFetchLike = fetch,
): MindsClient | null {
  const builderApiKey = env[MINDS_BUILDER_API_KEY_ENV]?.trim();
  if (!builderApiKey) {
    return null;
  }

  return new BuilderApiMindsClient({
    baseUrl: env.MINDS_BUILDER_API_BASE_URL?.trim() || MINDS_BUILDER_API_BASE_URL,
    builderApiKey,
    fetchImpl,
  });
}

class BuilderApiMindsClient implements MindsClient {
  private readonly baseUrl: string;
  private readonly builderApiKey: string;
  private readonly fetchImpl: MindsFetchLike;

  constructor(args: {
    baseUrl: string;
    builderApiKey: string;
    fetchImpl: MindsFetchLike;
  }) {
    this.baseUrl = args.baseUrl.replace(/\/$/, "");
    this.builderApiKey = args.builderApiKey;
    this.fetchImpl = args.fetchImpl;
  }

  async createMind(name: string): Promise<MindCreationResult> {
    const payload = await this.requestJson<BuilderMind | { mind: BuilderMind }>(
      "/v1/minds",
      {
        method: "POST",
        body: JSON.stringify({ name }),
      },
    );

    const mind = extractMindPayload(payload);
    if (typeof mind.mindId !== "string" || !mind.mindId.trim()) {
      throw new Error("Minds createMind response did not include mindId.");
    }

    return { mindId: mind.mindId };
  }

  async addTenets(mindId: string, tenets: InitialTenets): Promise<void> {
    await this.requestJson(`/v1/minds/${encodeURIComponent(mindId)}/tenets`, {
      method: "POST",
      body: JSON.stringify({ tenets }),
    });
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        [MINDS_BUILDER_API_KEY_HEADER]: this.builderApiKey,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Minds Builder API request failed with ${response.status}: ${detail}`,
      );
    }

    return (await response.json()) as T;
  }
}

function extractMindPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new Error("Minds createMind response must be a JSON object.");
  }

  const nestedMind = payload.mind;
  if (isRecord(nestedMind)) {
    return nestedMind;
  }

  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
