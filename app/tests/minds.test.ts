import test from "node:test";
import assert from "node:assert/strict";

import {
  MINDS_BUILDER_API_BASE_URL,
  MINDS_BUILDER_API_KEY_HEADER,
  MINDS_BUILDER_API_KEY_ENV,
  createMindsClientFromEnv,
  type MindsFetchLike,
  type MindsMessagingClientLike,
} from "../lib/minds";
import type { InitialTenets } from "../lib/tenets";

const tenets: InitialTenets = {
  version: "voice-distill-v1",
  generatedAt: "2026-07-26T00:00:00.000Z",
  voiceProfile: {
    sentenceStructure: ["Short setup, then a quick punchline."],
    phrasingHabits: ["Uses wait and watch to focus attention."],
    hookStyle: ["Opens with an immediate reaction."],
    vocabulary: ["wait", "moment"],
  },
  clipTasteProfile: {
    preferredMoments: ["Sudden reversals after a quiet setup."],
    pacing: ["Fast setup with payoff inside ten seconds."],
    emotionalSignals: ["Surprised laughter and rising volume."],
    clipPatterns: ["Setup, mistake, reaction."],
  },
  guardrails: ["Keep the dry reaction style."],
};

test("createMind uses the real one-click Builder API contract", async () => {
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetchImpl: MindsFetchLike = async (input, init) => {
    calls.push({ input, init });
    return {
      ok: true,
      status: 200,
      async text() {
        return "";
      },
      async json() {
        return {
          mindId: "mind_123",
          mindName: "ClipMind creator",
          mindEmail: "mind_123@hellominds.ai",
          humanId: "human_123",
          dnaArtifactId: "dna_123",
          dnaLibrary: [],
        };
      },
    };
  };

  const client = createMindsClientFromEnv(
    { [MINDS_BUILDER_API_KEY_ENV]: "test-key" },
    fetchImpl,
    () => recordingMessagingClient(),
  );
  assert.ok(client);

  const result = await client.createMind(
    "ClipMind creator",
    "creator@example.com",
  );

  assert.deepEqual(result, {
    mindId: "mind_123",
    mindEmail: "mind_123@hellominds.ai",
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.input,
    `${MINDS_BUILDER_API_BASE_URL}/v1/minds/one-click`,
  );
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(calls[0]?.init?.headers, {
    [MINDS_BUILDER_API_KEY_HEADER]: "test-key",
    "Content-Type": "application/json",
  });
  assert.equal(
    calls[0]?.init?.body,
    JSON.stringify({
      stewardEmail: "creator@example.com",
      mindName: "ClipMind creator",
      archetype: "organisational",
      species: "moca",
    }),
  );
});

test("addTenets seeds via one client-lib message and verifyTenets uses a second conversation", async () => {
  const messagingClient = recordingMessagingClient(
    "Stored dry reaction style.",
    "Current Tenets include dry reaction style and fast payoff clips.",
  );
  const client = createMindsClientFromEnv(
    { [MINDS_BUILDER_API_KEY_ENV]: "test-key" },
    async () => {
      throw new Error("fetch should not be used for messaging.");
    },
    () => messagingClient,
  );
  assert.ok(client);

  const seedReply = await client.addTenets("mind_abc-123", tenets);
  const reply = await client.verifyTenets("mind_abc-123");

  assert.equal(seedReply, "Stored dry reaction style.");
  assert.equal(
    reply,
    "Current Tenets include dry reaction style and fast payoff clips.",
  );
  assert.equal(messagingClient.sentMessages.length, 2);
  assert.equal(messagingClient.sentMessages[0]?.alias, "clipmind-onboarding-mindabc123");
  assert.equal(messagingClient.sentMessages[1]?.alias, "clipmind-verify-mindabc123");
  assert.notEqual(
    messagingClient.sentMessages[0]?.alias,
    messagingClient.sentMessages[1]?.alias,
  );
  assert.match(
    messagingClient.sentMessages[0]?.messageText ?? "",
    /Prompt version: tenet-seed-v1/,
  );
  assert.match(
    messagingClient.sentMessages[0]?.messageText ?? "",
    /"phrasingHabits": \[/,
  );
  assert.match(
    messagingClient.sentMessages[1]?.messageText ?? "",
    /Prompt version: tenet-verify-v1/,
  );
});

function recordingMessagingClient(
  seedReply = "Stored.",
  verifyReply = "Verified.",
) {
  const state = {
    ensuredConversations: [] as { alias: string; mindId: string }[],
    sentMessages: [] as { alias: string; messageText: string }[],
    waitRequests: [] as {
      alias: string;
      sentMessageText?: string;
      afterFingerprint?: string;
    }[],
  };

  return Object.assign(state, {
    async ensureConversation(alias: string, mindId: string) {
      state.ensuredConversations.push({ alias, mindId });
      return { alias, mindId };
    },
    async getLatestHistoryFingerprint(alias: string) {
      return `${alias}-before`;
    },
    async sendMessage(body: { alias: string; messageText: string }) {
      state.sentMessages.push(body);
      return {};
    },
    async waitForReply(args: {
      alias: string;
      sentMessageText?: string;
      afterFingerprint?: string;
    }) {
      state.waitRequests.push(args);
      return {
        timedOut: false as const,
        reply: {
          messageText:
            state.waitRequests.length === 1 ? seedReply : verifyReply,
        },
      };
    },
  } satisfies MindsMessagingClientLike);
}
