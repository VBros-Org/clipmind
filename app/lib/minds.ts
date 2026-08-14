import type {
  MessagingEvent,
  MindsClient as MindsMessagingClient,
} from "@animocabrands/minds-client-lib";

import {
  buildTenetSeedMessage,
  buildTenetVerificationMessage,
} from "./prompts/tenet-seed";
import type { InitialTenets } from "./tenets";

export const MINDS_BUILDER_API_KEY_ENV = "MINDS_BUILDER_API_KEY";
export const MINDS_BUILDER_API_KEY_HEADER = "X-Api-Key";
export const MINDS_BUILDER_API_BASE_URL = "https://api.build.hellominds.ai";
export const MINDS_CREATION_SKIPPED_MESSAGE =
  "MINDS_BUILDER_API_KEY not set, Mind creation skipped";

const MIND_CREATE_PATH = "/v1/minds/one-click";
const TENET_SEED_ALIAS_PREFIX = "clipmind-onboarding";
const TENET_VERIFY_ALIAS_PREFIX = "clipmind-verify";
const MIND_REPLY_TIMEOUT_MS = 300_000;
const importMindsClientLib = new Function(
  "specifier",
  "return import(specifier)",
) as (
  specifier: string,
) => Promise<typeof import("@animocabrands/minds-client-lib")>;

export interface MindCreationResult {
  mindId: string;
  mindEmail: string;
}

export interface MindsClient {
  createMind(name: string, stewardEmail: string): Promise<MindCreationResult>;
  disableMind?(mindId: string): Promise<void>;
  addTenets(
    mindId: string,
    tenets: InitialTenets,
    options?: {
      alias?: string;
      action?: string;
    },
  ): Promise<string>;
  verifyTenets(mindId: string): Promise<string>;
  sendMessageAndWaitForReply(args: MindMessageRequest): Promise<string>;
}

export type MindMessageRequest = {
  mindId: string;
  alias: string;
  messageText: string;
  action: string;
};

export type MindsFetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "text" | "json">>;

export type MindsMessagingClientFactory = (
  builderApiKey: string,
) => MindsMessagingClientLike;

export interface MindsMessagingClientLike {
  ensureConversation(
    alias: string,
    mindId: string,
  ): Promise<Record<string, unknown>>;
  getLatestHistoryFingerprint(
    alias: string,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  sendMessage(body: {
    alias: string;
    messageText: string;
  }): Promise<Record<string, unknown>>;
  waitForReply(args: {
    alias: string;
    timeoutMs: number;
    sentMessageText?: string;
    afterFingerprint?: string;
    signal?: AbortSignal;
  }): Promise<
    | {
        reply: Pick<MessagingEvent, "messageText">;
        timedOut: false;
      }
    | {
        timedOut: true;
      }
  >;
}

export function createMindsClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: MindsFetchLike = fetch,
  messagingClientFactory: MindsMessagingClientFactory = createMessagingClient,
): MindsClient | null {
  const builderApiKey = env[MINDS_BUILDER_API_KEY_ENV]?.trim();
  if (!builderApiKey) {
    return null;
  }

  return new BuilderApiMindsClient({
    baseUrl: env.MINDS_BUILDER_API_BASE_URL?.trim() || MINDS_BUILDER_API_BASE_URL,
    builderApiKey,
    fetchImpl,
    messagingClient: messagingClientFactory(builderApiKey),
  });
}

class BuilderApiMindsClient implements MindsClient {
  private readonly baseUrl: string;
  private readonly builderApiKey: string;
  private readonly fetchImpl: MindsFetchLike;
  private readonly messagingClient: MindsMessagingClientLike;

  constructor(args: {
    baseUrl: string;
    builderApiKey: string;
    fetchImpl: MindsFetchLike;
    messagingClient: MindsMessagingClientLike;
  }) {
    this.baseUrl = args.baseUrl.replace(/\/$/, "");
    this.builderApiKey = args.builderApiKey;
    this.fetchImpl = args.fetchImpl;
    this.messagingClient = args.messagingClient;
  }

  async createMind(
    name: string,
    stewardEmail: string,
  ): Promise<MindCreationResult> {
    const payload = await this.requestJson<Record<string, unknown>>(
      MIND_CREATE_PATH,
      {
        method: "POST",
        body: JSON.stringify({
          stewardEmail,
          mindName: name,
          archetype: "organisational",
          species: "moca",
        }),
      },
    );

    const mindId = readRequiredString(payload, "mindId", "createMind response");
    const mindEmail = readRequiredString(
      payload,
      "mindEmail",
      "createMind response",
    );

    return { mindId, mindEmail };
  }

  async disableMind(mindId: string): Promise<void> {
    const cleanMindId = mindId.trim();
    if (!cleanMindId) {
      throw new Error("Mind id is required to disable a Mind.");
    }

    await this.requestJson<Record<string, unknown>>(
      `/v1/minds/${encodeURIComponent(cleanMindId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          isEnabled: false,
        }),
      },
    );
  }

  async addTenets(
    mindId: string,
    tenets: InitialTenets,
    options: { alias?: string; action?: string } = {},
  ): Promise<string> {
    const alias =
      options.alias?.trim() ||
      buildConversationAlias(TENET_SEED_ALIAS_PREFIX, mindId);
    const messageText = buildTenetSeedMessage(tenets);

    return this.sendMessageAndWaitForReply({
      mindId,
      alias,
      messageText,
      action: options.action?.trim() || "Tenet seed",
    });
  }

  async verifyTenets(mindId: string): Promise<string> {
    const alias = buildConversationAlias(TENET_VERIFY_ALIAS_PREFIX, mindId);
    const messageText = buildTenetVerificationMessage();

    return this.sendMessageAndWaitForReply({
      mindId,
      alias,
      messageText,
      action: "Tenet verification",
    });
  }

  async sendMessageAndWaitForReply(
    args: MindMessageRequest,
  ): Promise<string> {
    await this.messagingClient.ensureConversation(args.alias, args.mindId);
    const afterFingerprint =
      await this.messagingClient.getLatestHistoryFingerprint(args.alias);
    await this.messagingClient.sendMessage({
      alias: args.alias,
      messageText: args.messageText,
    });

    return this.waitForMindReply({
      alias: args.alias,
      messageText: args.messageText,
      afterFingerprint,
      action: args.action,
    });
  }

  private async waitForMindReply(args: {
    alias: string;
    messageText: string;
    afterFingerprint?: string;
    action: string;
  }): Promise<string> {
    const outcome = await this.messagingClient.waitForReply({
      alias: args.alias,
      timeoutMs: MIND_REPLY_TIMEOUT_MS,
      sentMessageText: args.messageText,
      afterFingerprint: args.afterFingerprint,
    });

    if (outcome.timedOut) {
      throw new Error(`${args.action} timed out waiting for a Mind reply.`);
    }

    const replyText = outcome.reply.messageText?.trim();
    if (!replyText) {
      throw new Error(`${args.action} reply did not include message text.`);
    }

    return replyText;
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

function createMessagingClient(builderApiKey: string): MindsMessagingClientLike {
  let clientPromise: Promise<MindsMessagingClient> | null = null;

  async function getClient(): Promise<MindsMessagingClient> {
    clientPromise ??= importMindsClientLib(
      "@animocabrands/minds-client-lib",
    ).then((module) =>
      module.createMindsClient({
        builderApiKey,
      }),
    );

    return clientPromise;
  }

  return {
    async ensureConversation(alias, mindId) {
      return (await getClient()).ensureConversation(alias, mindId);
    },
    async getLatestHistoryFingerprint(alias, signal) {
      return (await getClient()).getLatestHistoryFingerprint(alias, signal);
    },
    async sendMessage(body) {
      return (await getClient()).sendMessage(body);
    },
    async waitForReply(args) {
      return (await getClient()).waitForReply(args);
    },
  };
}

function readRequiredString(
  payload: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Minds ${context} did not include ${key}.`);
  }

  return value;
}

function buildConversationAlias(prefix: string, mindId: string): string {
  const suffix = mindId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "mind";
  return `${prefix}-${suffix}`.slice(0, 64);
}
