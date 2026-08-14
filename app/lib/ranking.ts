import type { PrismaClient } from "@prisma/client";

import {
  MINDS_BUILDER_API_KEY_ENV,
  createMindsClientFromEnv,
  type MindsClient,
} from "./minds";
import { buildRankClipsMessage } from "./prompts/rank-clips";

const MAX_RANKING_ATTEMPTS = 2;
const NOT_RANKED_REASON = "not ranked by Mind";
const importDb = new Function(
  "specifier",
  "return import(specifier)",
) as (specifier: string) => Promise<typeof import("./db")>;

export type RankingClipStatus =
  | "candidate"
  | "accepted"
  | "rejected"
  | "scheduled"
  | "posted";

export type RankingCandidateClip = {
  id: string;
  startMs: number;
  endMs: number;
  transcript: string | null;
  status: RankingClipStatus;
  createdAt: Date;
};

export type RankingRequestData = {
  creatorExists: boolean;
  creatorMindId: string | null;
  videoExists: boolean;
  clips: RankingCandidateClip[];
};

export type RankingWrite = {
  clipId: string;
  candidateIndex: number;
  mindRank: number;
  reason: string;
  expectedStatus: RankingClipStatus;
};

export type RankedClip = RankingWrite & {
  startMs: number;
  endMs: number;
  transcript: string | null;
  status: RankingClipStatus;
};

export interface RankingStore {
  loadCandidateRankingRequest(
    creatorId: string,
    videoId: string,
  ): Promise<RankingRequestData>;
  writeCandidateRankings(args: {
    clips: readonly RankingCandidateClip[];
    rankings: readonly RankingWrite[];
  }): Promise<RankedClip[]>;
}

export type RankCandidatesResult =
  | {
      status: "ranked";
      creatorId: string;
      videoId: string;
      mindId: string;
      attempts: number;
      rankings: RankedClip[];
    }
  | {
      status: "empty";
      creatorId: string;
      videoId: string;
      reason: "no_candidate_clips";
    }
  | {
      status: "failed";
      creatorId: string;
      videoId: string;
      reason: "unparseable_mind_reply";
      attempts: number;
      replies: string[];
    };

export type RankCandidatesOptions = {
  mindsClient?: Pick<MindsClient, "sendMessageAndWaitForReply">;
  prismaClient?: PrismaClient;
  store?: RankingStore;
  env?: NodeJS.ProcessEnv;
};

export type ParsedMindRanking = {
  index: number;
  reason: string;
};

export async function rankCandidates(
  creatorId: string,
  videoId: string,
  options: RankCandidatesOptions = {},
): Promise<RankCandidatesResult> {
  const store =
    options.store ?? (await createPrismaRankingStore(options.prismaClient));
  const request = await store.loadCandidateRankingRequest(creatorId, videoId);

  if (!request.creatorExists) {
    throw new Error(`Creator ${creatorId} does not exist.`);
  }

  const mindId = request.creatorMindId?.trim();
  if (!mindId) {
    throw new Error(`Creator ${creatorId} does not have a Mind id.`);
  }

  if (!request.videoExists) {
    throw new Error(`Video ${videoId} does not exist for creator ${creatorId}.`);
  }

  if (request.clips.length === 0) {
    return {
      status: "empty",
      creatorId,
      videoId,
      reason: "no_candidate_clips",
    };
  }

  const mindsClient =
    options.mindsClient ?? createMindsClientFromEnv(options.env ?? process.env);
  if (!mindsClient) {
    throw new Error(`${MINDS_BUILDER_API_KEY_ENV} is required to rank clips.`);
  }

  const prompt = buildRankClipsMessage(
    request.clips.map((clip, index) => ({
      index: index + 1,
      durationMs: clip.endMs - clip.startMs,
      transcript: clip.transcript,
    })),
  );

  const replies: string[] = [];

  for (let attempt = 1; attempt <= MAX_RANKING_ATTEMPTS; attempt += 1) {
    const reply = await mindsClient.sendMessageAndWaitForReply({
      mindId,
      alias: buildRankingConversationAlias(videoId, attempt),
      messageText: prompt,
      action: `Clip ranking attempt ${attempt}`,
    });
    replies.push(reply);

    const parsed = parseMindRankingReply(reply, request.clips.length);
    if (!parsed) {
      continue;
    }

    const rankings = buildRankingWrites(request.clips, parsed);
    const rankedClips = await store.writeCandidateRankings({
      clips: request.clips,
      rankings,
    });
    assertStatusesUnchanged(request.clips, rankedClips);

    return {
      status: "ranked",
      creatorId,
      videoId,
      mindId,
      attempts: attempt,
      rankings: rankedClips,
    };
  }

  return {
    status: "failed",
    creatorId,
    videoId,
    reason: "unparseable_mind_reply",
    attempts: MAX_RANKING_ATTEMPTS,
    replies,
  };
}

export function parseMindRankingReply(
  replyText: string,
  candidateCount: number,
): ParsedMindRanking[] | null {
  const stripped = stripHtmlTags(replyText);
  const payload = extractFirstJsonArray(stripped);
  if (!payload) {
    return null;
  }

  const seen = new Set<number>();
  const ranked: ParsedMindRanking[] = [];

  for (const item of payload) {
    if (!isRecord(item)) {
      continue;
    }

    const index = item.index;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 1 ||
      index > candidateCount ||
      seen.has(index)
    ) {
      continue;
    }

    seen.add(index);
    ranked.push({
      index,
      reason: normalizeReason(item.reason),
    });
  }

  for (let index = 1; index <= candidateCount; index += 1) {
    if (!seen.has(index)) {
      ranked.push({
        index,
        reason: NOT_RANKED_REASON,
      });
    }
  }

  return ranked;
}

function buildRankingWrites(
  clips: readonly RankingCandidateClip[],
  parsed: readonly ParsedMindRanking[],
): RankingWrite[] {
  return parsed.map((entry, rankingIndex) => {
    const clip = clips[entry.index - 1];
    if (!clip) {
      throw new Error(`Mind ranking referenced missing index ${entry.index}.`);
    }

    return {
      clipId: clip.id,
      candidateIndex: entry.index,
      mindRank: rankingIndex + 1,
      reason: entry.reason,
      expectedStatus: clip.status,
    };
  });
}

function stripHtmlTags(text: string): string {
  return decodeBasicHtmlEntities(text.replace(/<[^>]*>/g, " "));
}

function decodeBasicHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractFirstJsonArray(text: string): unknown[] | null {
  let startIndex = text.indexOf("[");

  while (startIndex >= 0) {
    const arrayText = readBracketedArray(text, startIndex);
    if (arrayText) {
      try {
        const parsed = JSON.parse(arrayText);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // Keep scanning. Mind replies can contain prose before the array.
      }
    }

    startIndex = text.indexOf("[", startIndex + 1);
  }

  return null;
}

function readBracketedArray(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "[") {
      depth += 1;
      continue;
    }

    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function normalizeReason(value: unknown): string {
  if (typeof value !== "string") {
    return "ranked by Mind";
  }

  return value.trim().replace(/\s+/g, " ") || "ranked by Mind";
}

async function createPrismaRankingStore(
  prismaClient?: PrismaClient,
): Promise<RankingStore> {
  if (prismaClient) {
    return new PrismaRankingStore(prismaClient);
  }

  const { prisma } = await importDb("./db.js");
  return new PrismaRankingStore(prisma);
}

class PrismaRankingStore implements RankingStore {
  constructor(private readonly db: PrismaClient) {}

  async loadCandidateRankingRequest(
    creatorId: string,
    videoId: string,
  ): Promise<RankingRequestData> {
    const [creator, video, clips] = await Promise.all([
      this.db.creator.findUnique({
        where: {
          id: creatorId,
        },
        select: {
          mindId: true,
        },
      }),
      this.db.video.findFirst({
        where: {
          id: videoId,
          creatorId,
        },
        select: {
          id: true,
        },
      }),
      this.db.clip.findMany({
        where: {
          creatorId,
          videoId,
          status: "candidate",
        },
        select: {
          id: true,
          startMs: true,
          endMs: true,
          transcript: true,
          status: true,
          createdAt: true,
        },
        orderBy: [
          {
            createdAt: "asc",
          },
          {
            id: "asc",
          },
        ],
      }),
    ]);

    return {
      creatorExists: Boolean(creator),
      creatorMindId: creator?.mindId ?? null,
      videoExists: Boolean(video),
      clips: clips.map((clip) => ({
        ...clip,
        status: toRankingClipStatus(clip.status),
      })),
    };
  }

  async writeCandidateRankings(args: {
    clips: readonly RankingCandidateClip[];
    rankings: readonly RankingWrite[];
  }): Promise<RankedClip[]> {
    const expectedStatusById = new Map(
      args.clips.map((clip) => [clip.id, clip.status]),
    );
    const ids = args.rankings.map((ranking) => ranking.clipId);

    return this.db.$transaction(async (tx) => {
      const before = await tx.clip.findMany({
        where: {
          id: {
            in: ids,
          },
        },
        select: {
          id: true,
          status: true,
        },
      });
      assertStoredStatuses(expectedStatusById, before, "before ranking write");

      for (const ranking of args.rankings) {
        const updateResult = await tx.clip.updateMany({
          where: {
            id: ranking.clipId,
            status: ranking.expectedStatus,
          },
          data: {
            mindRank: ranking.mindRank,
            mindRankReason: ranking.reason,
          },
        });
        if (updateResult.count !== 1) {
          throw new Error(
            `Ranking status assertion failed during ranking write: clip ${ranking.clipId} changed from ${ranking.expectedStatus}.`,
          );
        }
      }

      const after = await tx.clip.findMany({
        where: {
          id: {
            in: ids,
          },
        },
        select: {
          id: true,
          startMs: true,
          endMs: true,
          transcript: true,
          status: true,
          mindRank: true,
          mindRankReason: true,
        },
      });
      assertStoredStatuses(expectedStatusById, after, "after ranking write");

      const afterById = new Map(after.map((clip) => [clip.id, clip]));

      return args.rankings.map((ranking) => {
        const stored = afterById.get(ranking.clipId);
        if (!stored) {
          throw new Error(`Clip ${ranking.clipId} was not found after ranking.`);
        }

        return {
          ...ranking,
          startMs: stored.startMs,
          endMs: stored.endMs,
          transcript: stored.transcript,
          status: toRankingClipStatus(stored.status),
          reason: stored.mindRankReason ?? ranking.reason,
          mindRank: stored.mindRank ?? ranking.mindRank,
        };
      });
    });
  }
}

function assertStoredStatuses(
  expectedStatusById: ReadonlyMap<string, RankingClipStatus>,
  clips: readonly { id: string; status: string }[],
  context: string,
): void {
  if (clips.length !== expectedStatusById.size) {
    throw new Error(`Ranking status assertion failed ${context}: missing clips.`);
  }

  for (const clip of clips) {
    const expectedStatus = expectedStatusById.get(clip.id);
    if (!expectedStatus) {
      throw new Error(
        `Ranking status assertion failed ${context}: unexpected clip ${clip.id}.`,
      );
    }

    if (toRankingClipStatus(clip.status) !== expectedStatus) {
      throw new Error(
        `Ranking status assertion failed ${context}: clip ${clip.id} changed from ${expectedStatus} to ${clip.status}.`,
      );
    }
  }
}

function assertStatusesUnchanged(
  before: readonly RankingCandidateClip[],
  after: readonly RankedClip[],
): void {
  const beforeStatusById = new Map(before.map((clip) => [clip.id, clip.status]));

  for (const rankedClip of after) {
    const beforeStatus = beforeStatusById.get(rankedClip.clipId);
    if (beforeStatus !== rankedClip.status) {
      throw new Error(
        `Ranking changed Clip.status for ${rankedClip.clipId} from ${beforeStatus ?? "missing"} to ${rankedClip.status}.`,
      );
    }
  }
}

function buildRankingConversationAlias(videoId: string, attempt: number): string {
  const shortVideoId = videoId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
  return `clipmind-rank-${shortVideoId || "video"}-${attempt}`.slice(0, 64);
}

function toRankingClipStatus(status: string): RankingClipStatus {
  switch (status) {
    case "candidate":
    case "accepted":
    case "rejected":
    case "scheduled":
    case "posted":
      return status;
    default:
      throw new Error(`Unknown Clip.status ${status}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
