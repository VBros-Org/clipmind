import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTasteFeedbackConversationAlias,
  syncTasteFeedback,
  triggerTasteFeedbackSyncAfterVerdict,
  type SyncTasteFeedbackResult,
  type TasteFeedbackClip,
  type TasteFeedbackStore,
  type TasteFeedbackVerdict,
} from "../lib/tasteFeedback";

const FIXED_NOW = new Date("2026-07-29T10:11:12.000Z");

test("syncTasteFeedback batches only unsynced verdict clips and caps the batch at 10", async () => {
  const store = new MemoryTasteFeedbackStore({
    mindId: "mind-1",
    clips: [
      memoryClip("candidate-1", "candidate", "candidate should not send", 0),
      memoryClip("synced-1", "accepted", "synced should not send", 1, FIXED_NOW),
      ...Array.from({ length: 6 }, (_, index) =>
        memoryClip(
          `accepted-${index + 1}`,
          "accepted",
          `accepted transcript ${index + 1}`,
          index + 2,
        ),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        memoryClip(
          `rejected-${index + 1}`,
          "rejected",
          `rejected transcript ${index + 1}`,
          index + 8,
        ),
      ),
    ],
  });
  const mindsClient = fakeMindsClient(["Adjusted the taste Priors."]);

  const result = await syncTasteFeedback("creator-abc", {
    store,
    mindsClient,
    clock: fixedClock(),
    logger: quietLogger(),
  });

  assert.equal(result.status, "synced");
  assert.equal(result.clipIds.length, 10);
  assert.equal(result.acceptedCount, 6);
  assert.equal(result.rejectedCount, 4);
  assert.equal(
    result.alias,
    buildTasteFeedbackConversationAlias("creator-abc", 1, FIXED_NOW),
  );
  assert.equal(mindsClient.calls.length, 1);
  assert.match(mindsClient.calls[0]?.messageText ?? "", /taste-feedback-v1/);
  assert.match(
    mindsClient.calls[0]?.messageText ?? "",
    /bad clip window as a candidate detection or cut-window fault/,
  );
  assert.match(mindsClient.calls[0]?.messageText ?? "", /accepted transcript 1/);
  assert.match(mindsClient.calls[0]?.messageText ?? "", /rejected transcript 4/);
  assert.doesNotMatch(
    mindsClient.calls[0]?.messageText ?? "",
    /candidate should not send/,
  );
  assert.doesNotMatch(
    mindsClient.calls[0]?.messageText ?? "",
    /synced should not send/,
  );
  assert.equal(store.markCalls.length, 1);
  assert.deepEqual(
    store.markCalls[0]?.clipIds,
    [
      "accepted-1",
      "accepted-2",
      "accepted-3",
      "accepted-4",
      "accepted-5",
      "accepted-6",
      "rejected-1",
      "rejected-2",
      "rejected-3",
      "rejected-4",
    ],
  );
  assert.equal(store.find("rejected-5")?.feedbackSyncedAt, null);
});

test("syncTasteFeedback marks selected clips only after a successful Mind reply", async () => {
  const store = new MemoryTasteFeedbackStore({
    mindId: "mind-1",
    clips: [
      memoryClip("accepted-1", "accepted", "strong human yes", 1),
      memoryClip("rejected-1", "rejected", "flat human no", 2),
    ],
  });
  const mindsClient = fakeMindsClient(["Seek the sharp turn and avoid flat setup."]);

  const result = await syncTasteFeedback("creator-abc", {
    store,
    mindsClient,
    clock: fixedClock(),
    logger: quietLogger(),
  });

  assert.equal(result.status, "synced");
  assert.deepEqual(
    store.clips.map((clip) => clip.feedbackSyncedAt?.toISOString() ?? null),
    [FIXED_NOW.toISOString(), FIXED_NOW.toISOString()],
  );
});

test("syncTasteFeedback success log omits raw Mind confirmation and alias", async () => {
  const store = new MemoryTasteFeedbackStore({
    mindId: "mind-1",
    clips: [
      memoryClip("accepted-1", "accepted", "strong human yes", 1),
      memoryClip("rejected-1", "rejected", "flat human no", 2),
    ],
  });
  const mindsClient = fakeMindsClient([
    "Raw Mind reply with creator taste details.",
  ]);
  const logLines: string[] = [];

  await syncTasteFeedback("creator-abc", {
    store,
    mindsClient,
    clock: fixedClock(),
    logger: {
      error() {},
      log(line) {
        logLines.push(line);
      },
    },
  });

  assert.equal(logLines.length, 1);
  assert.match(logLines[0] ?? "", /creatorId=creator-abc/);
  assert.match(logLines[0] ?? "", /mindId=mind-1/);
  assert.match(logLines[0] ?? "", /clipIds=accepted-1,rejected-1/);
  assert.doesNotMatch(logLines[0] ?? "", /alias=/);
  assert.doesNotMatch(logLines[0] ?? "", /confirmation=/);
  assert.doesNotMatch(logLines[0] ?? "", /Raw Mind reply/);
});

test("syncTasteFeedback includes optional reject reasons in the Mind message", async () => {
  const store = new MemoryTasteFeedbackStore({
    mindId: "mind-1",
    clips: [
      memoryClip("rejected-1", "rejected", "flat window", 1, null, "weak moment"),
    ],
  });
  const mindsClient = fakeMindsClient(["Adjusted the weak moment pattern."]);

  await syncTasteFeedback("creator-abc", {
    store,
    mindsClient,
    clock: fixedClock(),
    logger: quietLogger(),
  });

  assert.match(mindsClient.calls[0]?.messageText ?? "", /human reject reason:/);
  assert.match(mindsClient.calls[0]?.messageText ?? "", /weak moment/);
});

test("syncTasteFeedback leaves clips unsynced when the Mind call fails", async () => {
  const store = new MemoryTasteFeedbackStore({
    mindId: "mind-1",
    clips: [memoryClip("accepted-1", "accepted", "would have synced", 1)],
  });
  const mindsClient = fakeMindsClient([new Error("Mind unavailable")]);

  await assert.rejects(
    syncTasteFeedback("creator-abc", {
      store,
      mindsClient,
      clock: fixedClock(),
      logger: quietLogger(),
    }),
    /Mind unavailable/,
  );

  assert.equal(store.markCalls.length, 0);
  assert.equal(store.find("accepted-1")?.feedbackSyncedAt, null);
});

test("syncTasteFeedback skips creators without a Mind id", async () => {
  const store = new MemoryTasteFeedbackStore({
    mindId: null,
    clips: [memoryClip("accepted-1", "accepted", "human yes", 1)],
  });
  const mindsClient = fakeMindsClient(["Should not be used."]);

  const result = await syncTasteFeedback("creator-abc", {
    store,
    mindsClient,
    clock: fixedClock(),
    logger: quietLogger(),
  });

  assert.deepEqual(result, {
    status: "skipped",
    creatorId: "creator-abc",
    reason: "no_mind",
  });
  assert.equal(mindsClient.calls.length, 0);
  assert.equal(store.markCalls.length, 0);
  assert.equal(store.find("accepted-1")?.feedbackSyncedAt, null);
});

test("triggerTasteFeedbackSyncAfterVerdict runs only when the threshold is met", async () => {
  const store = new MemoryTasteFeedbackStore({
    mindId: "mind-1",
    clips: [
      memoryClip("accepted-1", "accepted", "yes one", 1),
      memoryClip("rejected-1", "rejected", "no one", 2),
    ],
  });
  const syncCalls: string[] = [];
  const syncImpl = async (creatorId: string): Promise<SyncTasteFeedbackResult> => {
    syncCalls.push(creatorId);
    return {
      status: "empty",
      creatorId,
      reason: "no_unsynced_verdicts",
    };
  };

  const below = await triggerTasteFeedbackSyncAfterVerdict("creator-abc", {
    store,
    syncTasteFeedbackImpl: syncImpl,
    runInBackground: false,
    logger: quietLogger(),
  });
  assert.equal(below.status, "below_threshold");
  assert.equal(syncCalls.length, 0);

  store.clips.push(memoryClip("accepted-2", "accepted", "yes two", 3));

  const met = await triggerTasteFeedbackSyncAfterVerdict("creator-abc", {
    store,
    syncTasteFeedbackImpl: syncImpl,
    runInBackground: false,
    logger: quietLogger(),
  });
  assert.equal(met.status, "completed");
  assert.equal(syncCalls.length, 1);
});

type MemoryClip = Omit<TasteFeedbackClip, "verdict"> & {
  verdict: TasteFeedbackVerdict | "candidate";
  feedbackSyncedAt: Date | null;
};

class MemoryTasteFeedbackStore implements TasteFeedbackStore {
  readonly clips: MemoryClip[];
  readonly markCalls: { clipIds: string[]; syncedAt: Date }[] = [];

  constructor(private readonly args: {
    mindId: string | null;
    creatorExists?: boolean;
    clips: readonly MemoryClip[];
  }) {
    this.clips = args.clips.map((clip) => ({ ...clip }));
  }

  find(clipId: string): MemoryClip | undefined {
    return this.clips.find((clip) => clip.id === clipId);
  }

  async loadFeedbackBatch(
    _creatorId: string,
    limit: number,
  ): Promise<{
    creatorExists: boolean;
    creatorMindId: string | null;
    alreadySyncedCount: number;
    clips: TasteFeedbackClip[];
  }> {
    return {
      creatorExists: this.args.creatorExists ?? true,
      creatorMindId: this.args.mindId,
      alreadySyncedCount: this.clips.filter((clip) => clip.feedbackSyncedAt)
        .length,
      clips: this.unsyncedVerdicts()
        .slice(0, limit)
        .map(({ feedbackSyncedAt: _syncedAt, ...clip }) => ({
          ...clip,
          verdict: clip.verdict as TasteFeedbackVerdict,
        })),
    };
  }

  async markFeedbackSynced(args: {
    clipIds: readonly string[];
    syncedAt: Date;
  }): Promise<number> {
    this.markCalls.push({
      clipIds: [...args.clipIds],
      syncedAt: args.syncedAt,
    });

    for (const clipId of args.clipIds) {
      const clip = this.find(clipId);
      if (!clip || clip.feedbackSyncedAt) {
        throw new Error(`Cannot mark ${clipId}.`);
      }
      clip.feedbackSyncedAt = args.syncedAt;
    }

    return args.clipIds.length;
  }

  async countUnsyncedVerdictClips(): Promise<number> {
    return this.unsyncedVerdicts().length;
  }

  private unsyncedVerdicts(): MemoryClip[] {
    return this.clips
      .filter((clip) => clip.verdict !== "candidate")
      .filter((clip) => !clip.feedbackSyncedAt)
      .sort((left, right) => {
        const createdDiff = left.createdAt.getTime() - right.createdAt.getTime();
        return createdDiff || left.id.localeCompare(right.id);
      });
  }
}

function fakeMindsClient(replies: Array<string | Error>) {
  const calls: {
    mindId: string;
    alias: string;
    messageText: string;
    action: string;
  }[] = [];

  return {
    calls,
    async sendMessageAndWaitForReply(args: {
      mindId: string;
      alias: string;
      messageText: string;
      action: string;
    }) {
      calls.push(args);
      const reply = replies.shift();
      if (reply === undefined) {
        throw new Error("No fake Mind reply queued.");
      }
      if (reply instanceof Error) {
        throw reply;
      }

      return reply;
    },
  };
}

function memoryClip(
  id: string,
  verdict: TasteFeedbackVerdict | "candidate",
  transcript: string,
  order: number,
  feedbackSyncedAt: Date | null = null,
  rejectReason: string | null = null,
): MemoryClip {
  return {
    id,
    verdict,
    startMs: order * 10_000,
    endMs: order * 10_000 + 8_000,
    transcript,
    mindRank: order,
    mindRankReason: `Mind reason ${order}`,
    rejectReason,
    createdAt: new Date(`2026-07-29T00:${String(order).padStart(2, "0")}:00.000Z`),
    feedbackSyncedAt,
  };
}

function fixedClock() {
  return {
    now() {
      return FIXED_NOW;
    },
  };
}

function quietLogger() {
  return {
    error() {},
    log() {},
  };
}
