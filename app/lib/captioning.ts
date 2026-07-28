import type { Prisma, PrismaClient } from "@prisma/client";

import {
  MINDS_BUILDER_API_KEY_ENV,
  createMindsClientFromEnv,
  type MindsClient,
} from "./minds";
import { buildCaptionClipMessage } from "./prompts/caption-clip";

const MAX_CAPTION_ATTEMPTS = 2;
const FORBIDDEN_DASH_RE = /[\u2013\u2014]/;
const PLATFORM_COMPARISON_HASHTAG_RE = /(^|\s)#[^\s#]+/g;
const PLATFORM_COMPARISON_NOISE_RE = /[\s.,!?;:()[\]{}"'-]+/g;
const NEAR_IDENTICAL_PLATFORM_SIMILARITY = 0.92;
const MIN_NEAR_IDENTICAL_COMPARE_CHARS = 20;
const MIN_CONTAINED_PLATFORM_COMPARE_CHARS = 40;
const CONTAINED_PLATFORM_BODY_RATIO = 0.55;
const POST_COPY_PLATFORMS = ["youtube", "tiktok", "instagram"] as const;

export type CaptionPlatform = (typeof POST_COPY_PLATFORMS)[number];

export type PostCopyVariants = {
  youtube: string;
  tiktok: string;
  instagram: string;
};

export type CaptioningClipStatus =
  | "candidate"
  | "accepted"
  | "rejected"
  | "scheduled"
  | "posted";

export type CaptioningClip = {
  id: string;
  creatorId: string;
  videoId: string;
  startMs: number;
  endMs: number;
  transcript: string | null;
  status: CaptioningClipStatus;
  mindRank: number | null;
  mindRankReason: string | null;
  videoContext: string | null;
};

export type CaptioningRequestData = {
  clip: CaptioningClip | null;
  creatorMindId: string | null;
};

export type CaptioningWrite = {
  clip: CaptioningClip;
  variants: PostCopyVariants;
};

export type CaptionedClip = {
  clipId: string;
  creatorId: string;
  videoId: string;
  status: CaptioningClipStatus;
  mindRank: number | null;
  mindRankReason: string | null;
  postCopy: string | null;
  postCopyVariants: PostCopyVariants | null;
};

export interface CaptioningStore {
  loadCaptioningRequest(clipId: string): Promise<CaptioningRequestData>;
  writePostCopy(args: CaptioningWrite): Promise<CaptionedClip>;
}

export type CaptionClipResult =
  | {
      status: "captioned";
      clipId: string;
      creatorId: string;
      videoId: string;
      mindId: string;
      attempts: number;
      variants: PostCopyVariants;
    }
  | {
      status: "failed";
      clipId: string;
      creatorId: string;
      videoId: string;
      mindId: string;
      reason: "invalid_mind_reply";
      attempts: number;
      replies: string[];
      errors: string[];
    };

export type CaptionClipOptions = {
  mindsClient?: Pick<MindsClient, "sendMessageAndWaitForReply">;
  prismaClient?: PrismaClient;
  store?: CaptioningStore;
  env?: NodeJS.ProcessEnv;
};

export async function captionClip(
  clipId: string,
  options: CaptionClipOptions = {},
): Promise<CaptionClipResult> {
  const store =
    options.store ?? (await createPrismaCaptioningStore(options.prismaClient));
  const request = await store.loadCaptioningRequest(clipId);

  if (!request.clip) {
    throw new Error(`Clip ${clipId} does not exist.`);
  }

  const mindId = request.creatorMindId?.trim();
  if (!mindId) {
    throw new Error(`Creator ${request.clip.creatorId} does not have a Mind id.`);
  }

  const mindsClient =
    options.mindsClient ?? createMindsClientFromEnv(options.env ?? process.env);
  if (!mindsClient) {
    throw new Error(`${MINDS_BUILDER_API_KEY_ENV} is required to caption clips.`);
  }

  const replies: string[] = [];
  const errors: string[] = [];
  let correctiveNote: string | null = null;

  for (let attempt = 1; attempt <= MAX_CAPTION_ATTEMPTS; attempt += 1) {
    const reply = await mindsClient.sendMessageAndWaitForReply({
      mindId,
      alias: buildCaptionConversationAlias(clipId, attempt),
      messageText: buildCaptionAttemptMessage(request.clip, correctiveNote),
      action: `Clip caption attempt ${attempt}`,
    });
    replies.push(reply);

    const parsed = parseMindCaptionReply(reply);
    if (!parsed) {
      const error =
        "Mind caption reply did not include a JSON object with non-empty youtube, tiktok, and instagram strings.";
      errors.push(error);
      correctiveNote = error;
      continue;
    }

    const sanityError = findCaptionSanityError(parsed);
    if (sanityError) {
      errors.push(sanityError);
      correctiveNote = sanityError;
      continue;
    }

    const captionedClip = await store.writePostCopy({
      clip: request.clip,
      variants: parsed,
    });
    assertControlFieldsUnchanged(request.clip, captionedClip);

    return {
      status: "captioned",
      clipId,
      creatorId: request.clip.creatorId,
      videoId: request.clip.videoId,
      mindId,
      attempts: attempt,
      variants: parsed,
    };
  }

  return {
    status: "failed",
    clipId,
    creatorId: request.clip.creatorId,
    videoId: request.clip.videoId,
    mindId,
    reason: "invalid_mind_reply",
    attempts: MAX_CAPTION_ATTEMPTS,
    replies,
    errors,
  };
}

export function parseMindCaptionReply(
  replyText: string,
): PostCopyVariants | null {
  const payload = extractFirstJsonObject(stripHtmlTags(replyText));
  if (!isRecord(payload)) {
    return null;
  }

  const values: Partial<PostCopyVariants> = {};
  for (const platform of POST_COPY_PLATFORMS) {
    const value = payload[platform];
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }

    values[platform] = value.trim();
  }

  return values as PostCopyVariants;
}

export function findCaptionSanityError(
  variants: PostCopyVariants,
): string | null {
  for (const platform of POST_COPY_PLATFORMS) {
    if (FORBIDDEN_DASH_RE.test(variants[platform])) {
      return `${platform} contains an em dash or en dash character. Do not use em dashes or en dashes. Return clean JSON only.`;
    }
  }

  const platformSimilarityError = findPlatformSimilarityError(variants);
  if (platformSimilarityError) {
    return platformSimilarityError;
  }

  return null;
}

function findPlatformSimilarityError(
  variants: PostCopyVariants,
): string | null {
  const tiktok = normalizePlatformBodyForComparison(variants.tiktok);
  const instagram = normalizePlatformBodyForComparison(variants.instagram);

  if (!tiktok || !instagram) {
    return null;
  }

  if (tiktok === instagram) {
    return platformSimilarityCorrection();
  }

  if (isMostlyContainedPlatformBody(tiktok, instagram)) {
    return platformSimilarityCorrection();
  }

  if (
    Math.min(tiktok.length, instagram.length) >=
      MIN_NEAR_IDENTICAL_COMPARE_CHARS &&
    normalizedLevenshteinSimilarity(tiktok, instagram) >=
      NEAR_IDENTICAL_PLATFORM_SIMILARITY
  ) {
    return platformSimilarityCorrection();
  }

  return null;
}

function platformSimilarityCorrection(): string {
  return "tiktok and instagram are near-identical after removing hashtags and spacing, or one platform body mostly contains the other. TikTok must be a compact reactive caption with tags. Instagram must have a first-line hook, then a separate story or context line before tight tags. Return distinct clean JSON only.";
}

function normalizePlatformBodyForComparison(text: string): string {
  return text
    .replace(PLATFORM_COMPARISON_HASHTAG_RE, " ")
    .replace(PLATFORM_COMPARISON_NOISE_RE, "")
    .trim()
    .toLowerCase();
}

function isMostlyContainedPlatformBody(left: string, right: string): boolean {
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;

  return (
    shorter.length >= MIN_CONTAINED_PLATFORM_COMPARE_CHARS &&
    shorter.length / longer.length >= CONTAINED_PLATFORM_BODY_RATIO &&
    longer.includes(shorter)
  );
}

function normalizedLevenshteinSimilarity(left: string, right: string): number {
  const distance = levenshteinDistance(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  if (left.length < right.length) {
    return levenshteinDistance(right, left);
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];

    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      current[rightIndex + 1] = Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + substitutionCost,
      );
    }

    previous = current;
  }

  return previous[right.length];
}

function buildCaptionAttemptMessage(
  clip: CaptioningClip,
  correctiveNote: string | null,
): string {
  const prompt = buildCaptionClipMessage({
    durationMs: clip.endMs - clip.startMs,
    transcript: clip.transcript,
    videoContext: clip.videoContext,
  });

  if (!correctiveNote) {
    return prompt;
  }

  return [
    prompt,
    "",
    "Correction for this retry:",
    correctiveNote,
    'Reply only with {"youtube":"...","tiktok":"...","instagram":"..."} and three clean strings.',
  ].join("\n");
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

function extractFirstJsonObject(text: string): unknown | null {
  let startIndex = text.indexOf("{");

  while (startIndex >= 0) {
    const objectText = readBracketedObject(text, startIndex);
    if (objectText) {
      try {
        const parsed = JSON.parse(objectText);
        if (isRecord(parsed)) {
          return parsed;
        }
      } catch {
        // Keep scanning. Mind replies can contain prose before the object.
      }
    }

    startIndex = text.indexOf("{", startIndex + 1);
  }

  return null;
}

function readBracketedObject(text: string, startIndex: number): string | null {
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

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

async function createPrismaCaptioningStore(
  prismaClient?: PrismaClient,
): Promise<CaptioningStore> {
  if (prismaClient) {
    return new PrismaCaptioningStore(prismaClient);
  }

  const { prisma } = await import("./db.js");
  return new PrismaCaptioningStore(prisma);
}

class PrismaCaptioningStore implements CaptioningStore {
  constructor(private readonly db: PrismaClient) {}

  async loadCaptioningRequest(clipId: string): Promise<CaptioningRequestData> {
    const clip = await this.db.clip.findUnique({
      where: {
        id: clipId,
      },
      select: {
        id: true,
        creatorId: true,
        videoId: true,
        startMs: true,
        endMs: true,
        transcript: true,
        reasons: true,
        status: true,
        mindRank: true,
        mindRankReason: true,
        creator: {
          select: {
            mindId: true,
          },
        },
        video: {
          select: {
            contentKey: true,
            sourceUrl: true,
            status: true,
          },
        },
      },
    });

    if (!clip) {
      return {
        clip: null,
        creatorMindId: null,
      };
    }

    return {
      clip: {
        id: clip.id,
        creatorId: clip.creatorId,
        videoId: clip.videoId,
        startMs: clip.startMs,
        endMs: clip.endMs,
        transcript: clip.transcript,
        status: toCaptioningClipStatus(clip.status),
        mindRank: clip.mindRank,
        mindRankReason: clip.mindRankReason,
        videoContext: buildVideoContext(clip.video, clip.reasons),
      },
      creatorMindId: clip.creator.mindId,
    };
  }

  async writePostCopy(args: CaptioningWrite): Promise<CaptionedClip> {
    return this.db.$transaction(async (tx) => {
      const before = await tx.clip.findUnique({
        where: {
          id: args.clip.id,
        },
        select: {
          id: true,
          status: true,
          mindRank: true,
          mindRankReason: true,
        },
      });

      if (!before) {
        throw new Error(`Clip ${args.clip.id} does not exist.`);
      }
      assertStoredControlFields(args.clip, before, "before caption write");

      const updated = await tx.clip.update({
        where: {
          id: args.clip.id,
        },
        data: {
          postCopy: args.variants.tiktok,
          postCopyVariants: toPrismaJson(args.variants),
        },
        select: {
          id: true,
          creatorId: true,
          videoId: true,
          status: true,
          mindRank: true,
          mindRankReason: true,
          postCopy: true,
        },
      });

      assertStoredControlFields(args.clip, updated, "after caption write");

      return {
        clipId: updated.id,
        creatorId: updated.creatorId,
        videoId: updated.videoId,
        status: toCaptioningClipStatus(updated.status),
        mindRank: updated.mindRank,
        mindRankReason: updated.mindRankReason,
        postCopy: updated.postCopy,
        postCopyVariants: args.variants,
      };
    });
  }
}

function toPrismaJson(variants: PostCopyVariants): Prisma.InputJsonObject {
  return {
    youtube: variants.youtube,
    tiktok: variants.tiktok,
    instagram: variants.instagram,
  };
}

function buildVideoContext(
  video: {
    contentKey: string | null;
    sourceUrl: string | null;
    status: string;
  },
  reasons: Prisma.JsonValue | null,
): string | null {
  const lines = [`videoStatus=${video.status}`];

  if (video.sourceUrl) {
    lines.push(`sourceUrl=${video.sourceUrl}`);
  }
  if (video.contentKey) {
    lines.push(`contentKey=${video.contentKey}`);
  }

  const reasonsText = stringifyJson(reasons);
  if (reasonsText) {
    lines.push(`clipServiceReasons=${reasonsText}`);
  }

  return lines.join("\n");
}

function stringifyJson(value: Prisma.JsonValue | null): string | null {
  if (value === null) {
    return null;
  }

  return JSON.stringify(value);
}

function assertStoredControlFields(
  expected: CaptioningClip,
  stored: {
    id: string;
    status: string;
    mindRank: number | null;
    mindRankReason: string | null;
  },
  context: string,
): void {
  if (stored.id !== expected.id) {
    throw new Error(
      `Caption control-field assertion failed ${context}: unexpected clip ${stored.id}.`,
    );
  }

  const storedStatus = toCaptioningClipStatus(stored.status);
  if (storedStatus !== expected.status) {
    throw new Error(
      `Caption control-field assertion failed ${context}: Clip.status changed from ${expected.status} to ${storedStatus}.`,
    );
  }

  if (stored.mindRank !== expected.mindRank) {
    throw new Error(
      `Caption control-field assertion failed ${context}: Clip.mindRank changed from ${expected.mindRank} to ${stored.mindRank}.`,
    );
  }

  if (stored.mindRankReason !== expected.mindRankReason) {
    throw new Error(
      `Caption control-field assertion failed ${context}: Clip.mindRankReason changed.`,
    );
  }
}

function assertControlFieldsUnchanged(
  before: CaptioningClip,
  after: CaptionedClip,
): void {
  if (before.status !== after.status) {
    throw new Error(
      `Caption changed Clip.status for ${before.id} from ${before.status} to ${after.status}.`,
    );
  }

  if (before.mindRank !== after.mindRank) {
    throw new Error(
      `Caption changed Clip.mindRank for ${before.id} from ${before.mindRank} to ${after.mindRank}.`,
    );
  }

  if (before.mindRankReason !== after.mindRankReason) {
    throw new Error(`Caption changed Clip.mindRankReason for ${before.id}.`);
  }
}

function buildCaptionConversationAlias(
  clipId: string,
  attempt: number,
): string {
  const shortClipId = clipId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
  return `clipmind-caption-${shortClipId || "clip"}-${attempt}`.slice(0, 64);
}

function toCaptioningClipStatus(status: string): CaptioningClipStatus {
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
