import test from "node:test";
import assert from "node:assert/strict";

import {
  parseMindRankingReply,
  rankCandidates,
  type RankingCandidateClip,
  type RankingStore,
  type RankingWrite,
} from "../lib/ranking";

test("rankCandidates drops out-of-range indexes, dedupes duplicates, and appends missing candidates", async () => {
  const store = new MemoryRankingStore([
    clip("clip-1", 1_000, 11_000, "flat setup"),
    clip("clip-2", 12_000, 22_000, "quiet middle"),
    clip("clip-3", 23_000, 33_000, "last-second save"),
    clip("clip-4", 34_000, 44_000, "comedy fail"),
  ]);
  const mindsClient = fakeMindsClient([
    JSON.stringify([
      { index: 3, reason: "best last-second save" },
      { index: 99, reason: "not real" },
      { index: 3, reason: "duplicate should drop" },
      { index: 1, reason: "solid opener" },
    ]),
  ]);

  const result = await rankCandidates("creator-1", "video-abc", {
    store,
    mindsClient,
  });

  assert.equal(result.status, "ranked");
  assert.deepEqual(
    result.rankings.map((ranking) => ranking.candidateIndex),
    [3, 1, 2, 4],
  );
  assert.deepEqual(
    result.rankings.map((ranking) => ranking.reason),
    [
      "best last-second save",
      "solid opener",
      "not ranked by Mind",
      "not ranked by Mind",
    ],
  );
  assert.deepEqual(
    store.clips.map((storedClip) => storedClip.status),
    ["candidate", "candidate", "candidate", "candidate"],
  );
  assert.deepEqual(
    store.clips.map((storedClip) => storedClip.mindRank),
    [2, 3, 1, 4],
  );
  assert.equal(store.writeCalls.length, 1);
  assert.equal(mindsClient.calls[0]?.alias, "clipmind-rank-videoabc-1");
  assert.match(
    mindsClient.calls[0]?.messageText ?? "",
    /Prompt version: rank-clips-v1/,
  );
  assert.doesNotMatch(mindsClient.calls[0]?.messageText ?? "", /clip-1/);
});

test("rankCandidates parses HTML-wrapped JSON arrays", async () => {
  const store = new MemoryRankingStore([
    clip("clip-1", 1_000, 11_000, "inventory sorting"),
    clip("clip-2", 12_000, 22_000, "comedy fail"),
  ]);
  const mindsClient = fakeMindsClient([
    '<section><p>[{"index":2,"reason":"bigger reaction"},{"index":1,"reason":"flat"}]</p></section>',
  ]);

  const result = await rankCandidates("creator-1", "video-html", {
    store,
    mindsClient,
  });

  assert.equal(result.status, "ranked");
  assert.deepEqual(
    result.rankings.map((ranking) => ranking.candidateIndex),
    [2, 1],
  );
  assert.deepEqual(
    result.rankings.map((ranking) => ranking.reason),
    ["bigger reaction", "flat"],
  );
});

test("parseMindRankingReply keeps scanning past non-JSON bracketed prose", () => {
  assert.deepEqual(
    parseMindRankingReply(
      'Notes [not json] then [{"index":2,"reason":"real array"}]',
      2,
    ),
    [
      {
        index: 2,
        reason: "real array",
      },
      {
        index: 1,
        reason: "not ranked by Mind",
      },
    ],
  );
});

test("rankCandidates returns FAILED after two unparseable replies and writes nothing", async () => {
  const store = new MemoryRankingStore([
    clip("clip-1", 1_000, 11_000, "inventory sorting"),
    clip("clip-2", 12_000, 22_000, "last-second save"),
  ]);
  const mindsClient = fakeMindsClient([
    "I would pick the save first.",
    "<p>Still no JSON array.</p>",
  ]);

  const result = await rankCandidates("creator-1", "video-fail", {
    store,
    mindsClient,
  });

  assert.deepEqual(result, {
    status: "failed",
    creatorId: "creator-1",
    videoId: "video-fail",
    reason: "unparseable_mind_reply",
    attempts: 2,
    replies: ["I would pick the save first.", "<p>Still no JSON array.</p>"],
  });
  assert.equal(store.writeCalls.length, 0);
  assert.deepEqual(
    store.clips.map((storedClip) => ({
      status: storedClip.status,
      mindRank: storedClip.mindRank,
      mindRankReason: storedClip.mindRankReason,
    })),
    [
      {
        status: "candidate",
        mindRank: null,
        mindRankReason: null,
      },
      {
        status: "candidate",
        mindRank: null,
        mindRankReason: null,
      },
    ],
  );
});

type MemoryClip = RankingCandidateClip & {
  mindRank: number | null;
  mindRankReason: string | null;
};

class MemoryRankingStore implements RankingStore {
  readonly clips: MemoryClip[];
  readonly writeCalls: RankingWrite[][] = [];

  constructor(clips: readonly RankingCandidateClip[]) {
    this.clips = clips.map((candidate) => ({
      ...candidate,
      mindRank: null,
      mindRankReason: null,
    }));
  }

  async loadCandidateRankingRequest() {
    return {
      creatorExists: true,
      creatorMindId: "mind-1",
      videoExists: true,
      clips: this.clips
        .filter((candidate) => candidate.status === "candidate")
        .map(({ mindRank: _mindRank, mindRankReason: _reason, ...candidate }) => ({
          ...candidate,
        })),
    };
  }

  async writeCandidateRankings(args: {
    rankings: readonly RankingWrite[];
  }) {
    this.writeCalls.push(args.rankings.map((ranking) => ({ ...ranking })));

    return args.rankings.map((ranking) => {
      const storedClip = this.clips.find((candidate) => candidate.id === ranking.clipId);
      if (!storedClip) {
        throw new Error(`Unknown clip ${ranking.clipId}.`);
      }

      storedClip.mindRank = ranking.mindRank;
      storedClip.mindRankReason = ranking.reason;

      return {
        ...ranking,
        startMs: storedClip.startMs,
        endMs: storedClip.endMs,
        transcript: storedClip.transcript,
        status: storedClip.status,
      };
    });
  }
}

function fakeMindsClient(replies: string[]) {
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
      return reply;
    },
  };
}

function clip(
  id: string,
  startMs: number,
  endMs: number,
  transcript: string,
): RankingCandidateClip {
  return {
    id,
    startMs,
    endMs,
    transcript,
    status: "candidate",
    createdAt: new Date(startMs),
  };
}
