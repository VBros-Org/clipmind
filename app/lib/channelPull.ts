import type { Prisma, PrismaClient } from "@prisma/client";

import {
  ClipServiceApiError,
  clipServiceConfigFromEnv,
  listChannelWithClipService,
  transcribeRemoteWithClipService,
  type ChannelVideo,
} from "./clip-service";
import {
  YT_BLOCKED_CHANNEL_PULL_MESSAGE,
  friendlyChannelPullError,
  isActiveChannelPullStage,
  isChannelPullStage,
  type ActiveChannelPullStage,
  type ChannelPullStage,
} from "./channel-pull-status";
import { prisma } from "./db";
import {
  MINDS_BUILDER_API_KEY_ENV,
  createMindsClientFromEnv,
  type MindsClient,
} from "./minds";
import { ensureCreatorMind } from "./mind-provisioning";
import { seedCreatorTenets } from "./onboarding";
import { createOpenAITenetDistiller } from "./openai-distill";
import {
  CORPUS_WEIGHTS,
  type VoiceDistillEvidence,
  type WeightedTranscript,
} from "./prompts/voice-distill";
import { loadCreatorSessionFromCookieHeader } from "./review-auth";
import type { InitialTenets } from "./tenets";
import { parseTranscript, type Transcript } from "./transcript";
import { loadCreatorTranscriptEvidence } from "./voice-corpus";
import {
  WorkflowLeaseLostError,
  incrementStageAttempt,
  isWorkflowLeaseExpired,
  newWorkflowRunId,
  withWorkflowHeartbeat,
  workflowLeaseExpiredError,
} from "./workflow-lease";

export const CHANNEL_PULL_MAX_VIDEO_DURATION_S = 1_200;
export const CHANNEL_PULL_MAX_TRANSCRIPTS = 3;

const YOUTUBE_HANDLE_RE = /^@[A-Za-z0-9._-]{2,100}$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const RESERVED_YOUTUBE_PATHS = new Set([
  "embed",
  "feed",
  "playlist",
  "results",
  "shorts",
  "watch",
]);

export type ChannelPullClipServiceClient = {
  listChannel(channelUrl: string): Promise<ChannelVideo[]>;
  transcribeRemote(videoUrl: string, maxDurationS: number): Promise<Transcript>;
};

export type ChannelPullOptions = {
  prismaClient?: PrismaClient;
  clipServiceClient?: ChannelPullClipServiceClient;
  distillTenets?: (
    transcripts: WeightedTranscript[],
    evidence?: VoiceDistillEvidence,
  ) => Promise<InitialTenets>;
  mindsClient?: MindsClient | null;
  now?: Date;
  heartbeatIntervalMs?: number;
  adoptionPollMs?: number;
  maxAdoptionWaitMs?: number;
  stewardEmail?: string;
  channelUrl?: string;
  onStageChange?: (stage: ChannelPullStage) => void | Promise<void>;
};

export type PullChannelVoiceResult =
  | {
      status: "done";
      creatorId: string;
      channelUrl: string;
      mindId: string;
      mindEmail: string | null;
      listedCount: number;
      transcriptCount: number;
      selectedVideos: ChannelVideo[];
      confirmation: string;
    }
  | {
      status: "failed";
      creatorId: string;
      failedStage: ActiveChannelPullStage;
      error: string;
      errorCode: string | null;
    };

export type ChannelPullApiOptions = ChannelPullOptions & {
  pullChannelVoiceImpl?: (
    creatorId: string,
    options: ChannelPullOptions,
  ) => Promise<PullChannelVoiceResult>;
};

export class ChannelPullInputError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function pullChannelVoice(
  creatorId: string,
  options: ChannelPullOptions = {},
): Promise<PullChannelVoiceResult> {
  const db = options.prismaClient ?? prisma;
  const runId = newWorkflowRunId("channel-pull");
  let activeStage: ActiveChannelPullStage = "listing";

  try {
    const creator = await db.creator.findUniqueOrThrow({
      where: {
        id: creatorId,
      },
      select: {
        channelUrl: true,
      },
    });
    await claimChannelPullRun(db, creatorId, runId, options);
    const channelUrl = normalizeYouTubeChannelInput(
      options.channelUrl ?? creator.channelUrl ?? "",
    );
    const clipServiceClient =
      options.clipServiceClient ?? createDefaultClipServiceClient();

    await setChannelPullStage(db, creatorId, "listing", options, {
      runId,
      channelUrl,
    });
    const listedVideos = await withWorkflowHeartbeat(
      () => heartbeatChannelPullRun(db, creatorId, runId, options),
      () => clipServiceClient.listChannel(channelUrl),
      options.heartbeatIntervalMs,
    );
    const selectedVideos = selectChannelVideosForVoice(listedVideos);
    if (selectedVideos.length === 0) {
      throw new Error("No recent YouTube videos under 20 minutes.");
    }

    const channelTranscripts: WeightedTranscript[] = [];
    for (const [index, video] of selectedVideos.entries()) {
      activeStage = transcribingStage(index);
      await setChannelPullStage(db, creatorId, activeStage, options, {
        runId,
      });
      const persistedTranscript = await loadChannelPullTranscriptEvidence(
        db,
        creatorId,
        video,
      );
      if (persistedTranscript) {
        channelTranscripts.push(persistedTranscript);
        continue;
      }

      const transcript = await withWorkflowHeartbeat(
        () => heartbeatChannelPullRun(db, creatorId, runId, options),
        () =>
          clipServiceClient.transcribeRemote(
            video.url,
            CHANNEL_PULL_MAX_VIDEO_DURATION_S,
          ),
        options.heartbeatIntervalMs,
      );
      await storeChannelPullTranscript(db, creatorId, video, transcript);
      channelTranscripts.push(channelTranscriptEvidence(video, transcript));
    }

    activeStage = "distilling";
    await setChannelPullStage(db, creatorId, activeStage, options, {
      runId,
    });
    const [freshCreator, existingTranscripts] = await Promise.all([
      db.creator.findUniqueOrThrow({
        where: {
          id: creatorId,
        },
        select: {
          captionCorpus: true,
        },
      }),
      loadCreatorTranscriptEvidence(db, creatorId),
    ]);
    const transcripts = mergeChannelPullCorpus(
      existingTranscripts,
      channelTranscripts,
    );
    if (transcripts.length === 0 && !freshCreator.captionCorpus?.trim()) {
      throw new Error("No voice corpus evidence found.");
    }

    const distillTenets = options.distillTenets ?? createOpenAITenetDistiller();
    const tenets = await withWorkflowHeartbeat(
      () => heartbeatChannelPullRun(db, creatorId, runId, options),
      () =>
        distillTenets(transcripts, {
          captionCorpus: freshCreator.captionCorpus,
        }),
      options.heartbeatIntervalMs,
    );

    activeStage = "seeding";
    await setChannelPullStage(db, creatorId, activeStage, options, {
      runId,
    });
    const mindsClient = requireMindsClient(options.mindsClient);
    const now = options.now ?? new Date();
    assertValidDate(now, "now");
    const mind = await ensureCreatorMind({
      db,
      creatorId,
      runId,
      workflowName: "Channel pull",
      mindsClient,
      stewardEmail: options.stewardEmail,
      now: options.now,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      adoptionPollMs: options.adoptionPollMs,
      maxAdoptionWaitMs: options.maxAdoptionWaitMs,
      heartbeat: () => heartbeatChannelPullRun(db, creatorId, runId, options),
    });
    const mindId = mind.mindId;
    const mindEmail = mind.mindEmail;

    const confirmation = await withWorkflowHeartbeat(
      () => heartbeatChannelPullRun(db, creatorId, runId, options),
      () =>
        seedCreatorTenets(mindsClient, mindId, tenets, {
          alias: buildChannelPullReseedAlias(creatorId, now),
          action: "Channel pull Tenet seed",
        }),
      options.heartbeatIntervalMs,
    );

    const completed = await db.creator.updateMany({
      where: {
        id: creatorId,
        channelPullRunId: runId,
      },
      data: {
        channelUrl,
        channelPullStage: "done",
        channelPullError: null,
        initialTenets: tenets as unknown as Prisma.InputJsonValue,
        mindId,
        mindStage: "ready",
        mindError: null,
        channelPullLeaseHeartbeatAt: options.now ?? new Date(),
      },
    });
    if (completed.count !== 1) {
      throw new WorkflowLeaseLostError("Channel pull", creatorId);
    }
    await options.onStageChange?.("done");

    return {
      status: "done",
      creatorId,
      channelUrl,
      mindId,
      mindEmail,
      listedCount: listedVideos.length,
      transcriptCount: channelTranscripts.length,
      selectedVideos,
      confirmation,
    };
  } catch (error) {
    const errorCode = channelPullErrorCode(error);
    const errorText = `${activeStage}: ${errorCode ? `${errorCode}: ` : ""}${channelPullFailureMessage(error, errorCode)}`;
    await markChannelPullFailed(db, creatorId, runId, errorText, options);
    await options.onStageChange?.("failed");

    return {
      status: "failed",
      creatorId,
      failedStage: activeStage,
      error: errorText,
      errorCode,
    };
  }
}

export async function handleStartChannelPull(
  request: Request,
  options: ChannelPullApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSessionFromCookieHeader(
    request.headers.get("cookie"),
    options,
  );
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  let channelUrl: string;
  try {
    channelUrl = normalizeYouTubeChannelInput(
      readChannelUrl(await readJsonPayload(request)),
    );
  } catch (error) {
    if (error instanceof ChannelPullInputError) {
      return json({ error: error.message }, error.status);
    }
    throw error;
  }

  const db = options.prismaClient ?? prisma;
  const creator = await db.creator.findUniqueOrThrow({
    where: {
      id: session.creatorId,
    },
    select: {
      channelPullStage: true,
      channelPullLeaseHeartbeatAt: true,
    },
  });
  if (
    isActiveChannelPullStage(creator.channelPullStage) &&
    !isWorkflowLeaseExpired(
      creator.channelPullLeaseHeartbeatAt,
      options.now ?? new Date(),
    )
  ) {
    return json({ error: "Recent video pull is already running." }, 409);
  }

  const runId = newWorkflowRunId("channel-pull");
  await db.creator.update({
    where: {
      id: session.creatorId,
    },
    data: {
      channelUrl,
      channelPullStage: "listing",
      channelPullError: null,
      channelPullRunId: runId,
      channelPullLeaseHeartbeatAt: options.now ?? new Date(),
    },
  });

  startChannelPullInBackground(session.creatorId, channelUrl, options);

  return json(
    {
      channelUrl,
      stage: "listing",
      error: null,
      errorCode: null,
    },
    202,
  );
}

export async function handleGetChannelPullStatus(
  request: Request,
  options: ChannelPullApiOptions = {},
): Promise<Response> {
  const session = await loadCreatorSessionFromCookieHeader(
    request.headers.get("cookie"),
    options,
  );
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  const db = options.prismaClient ?? prisma;
  const creator = await db.creator.findUniqueOrThrow({
    where: {
      id: session.creatorId,
    },
    select: {
      channelPullStage: true,
      channelPullError: true,
      channelPullLeaseHeartbeatAt: true,
    },
  });

  return json(
    channelPullStatusResponse(creator.channelPullStage, creator.channelPullError, {
      leaseHeartbeatAt: creator.channelPullLeaseHeartbeatAt,
      now: options.now,
    }),
    200,
  );
}

export function channelPullStatusResponse(
  rawStage: string | null,
  rawError: string | null,
  lease: {
    leaseHeartbeatAt?: Date | null;
    now?: Date;
  } = {},
): {
  stage: ChannelPullStage | null;
  error: string | null;
  errorCode: string | null;
} {
  const stage = isChannelPullStage(rawStage) ? rawStage : null;
  const error =
    stage && isActiveChannelPullStage(stage) &&
    isWorkflowLeaseExpired(lease.leaseHeartbeatAt, lease.now ?? new Date())
      ? workflowLeaseExpiredError(stage)
      : rawError;
  return {
    stage: error && stage !== "done" ? "failed" : stage,
    error: error ? friendlyChannelPullError(error) : null,
    errorCode: channelPullErrorCodeFromText(error),
  };
}

export function normalizeYouTubeChannelInput(value: string): string {
  const text = value.trim();
  if (!text) {
    throw new ChannelPullInputError(400, "Paste a YouTube channel URL or @handle.");
  }

  if (YOUTUBE_HANDLE_RE.test(text)) {
    return `https://www.youtube.com/${text}`;
  }

  const withScheme = text.match(/^https?:\/\//i)
    ? text
    : text.match(/^(www\.)?(m\.)?youtube\.com\//i)
      ? `https://${text}`
      : text;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new ChannelPullInputError(400, "Paste a YouTube channel URL or @handle.");
  }

  if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new ChannelPullInputError(422, "YouTube only for now.");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  const first = parts[0] ?? "";
  if (!first) {
    throw new ChannelPullInputError(400, "Paste a YouTube channel URL or @handle.");
  }
  if (first.startsWith("@")) {
    return `https://www.youtube.com/${first}`;
  }
  if (["channel", "c", "user"].includes(first) && parts[1]) {
    return `https://www.youtube.com/${first}/${parts[1]}`;
  }
  if (!RESERVED_YOUTUBE_PATHS.has(first) && parts.length === 1) {
    return `https://www.youtube.com/${first}`;
  }

  throw new ChannelPullInputError(400, "Paste a YouTube channel URL or @handle.");
}

export function selectChannelVideosForVoice(videos: ChannelVideo[]): ChannelVideo[] {
  return videos
    .filter(
      (video) =>
        video.durationS !== null &&
        video.durationS <= CHANNEL_PULL_MAX_VIDEO_DURATION_S,
    )
    .slice(0, CHANNEL_PULL_MAX_TRANSCRIPTS);
}

export function mergeChannelPullCorpus(
  existingTranscripts: WeightedTranscript[],
  channelTranscripts: WeightedTranscript[],
): WeightedTranscript[] {
  const seen = new Set<string>();
  const selectedChannelSources = new Set(
    channelTranscripts.map((transcript) => transcript.source),
  );
  const merged: WeightedTranscript[] = [];
  for (const transcript of existingTranscripts) {
    if (selectedChannelSources.has(transcript.source)) {
      continue;
    }
    if (seen.has(transcript.source)) {
      continue;
    }
    seen.add(transcript.source);
    merged.push(transcript);
  }
  for (const transcript of channelTranscripts) {
    if (seen.has(transcript.source)) {
      continue;
    }
    seen.add(transcript.source);
    merged.push(transcript);
  }

  return merged;
}

export function buildChannelPullReseedAlias(creatorId: string, now: Date): string {
  assertValidDate(now, "now");
  const shortCreatorId =
    creatorId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "creator";
  const stamp = `${now.toISOString().slice(0, 10).replace(/-/g, "")}${now
    .toISOString()
    .slice(11, 19)
    .replace(/:/g, "")}`;

  return `clipmind-channel-${shortCreatorId}-${stamp}`.slice(0, 64);
}

function createDefaultClipServiceClient(): ChannelPullClipServiceClient {
  const config = clipServiceConfigFromEnv();
  return {
    listChannel(channelUrl) {
      return listChannelWithClipService(channelUrl, config);
    },
    transcribeRemote(videoUrl, maxDurationS) {
      return transcribeRemoteWithClipService(videoUrl, maxDurationS, config);
    },
  };
}

function transcribingStage(index: number): ActiveChannelPullStage {
  const stage = `transcribing_${index + 1}`;
  if (
    stage === "transcribing_1" ||
    stage === "transcribing_2" ||
    stage === "transcribing_3"
  ) {
    return stage;
  }

  throw new Error(`Invalid channel pull transcript index ${index}.`);
}

function channelTranscriptEvidence(
  video: ChannelVideo,
  transcript: Transcript,
): WeightedTranscript {
  return {
    source: `youtube:${video.videoId}`,
    sourceType: "source_video",
    weight: CORPUS_WEIGHTS.source_video,
    transcript,
  };
}

async function loadChannelPullTranscriptEvidence(
  db: PrismaClient,
  creatorId: string,
  video: ChannelVideo,
): Promise<WeightedTranscript | null> {
  const stored = await db.channelPullTranscript.findUnique({
    where: {
      creatorId_videoId: {
        creatorId,
        videoId: video.videoId,
      },
    },
    select: {
      transcript: true,
    },
  });
  if (!stored) {
    return null;
  }

  return channelTranscriptEvidence(video, parseTranscript(stored.transcript));
}

async function storeChannelPullTranscript(
  db: PrismaClient,
  creatorId: string,
  video: ChannelVideo,
  transcript: Transcript,
): Promise<void> {
  await db.channelPullTranscript.upsert({
    where: {
      creatorId_videoId: {
        creatorId,
        videoId: video.videoId,
      },
    },
    create: {
      creatorId,
      videoId: video.videoId,
      videoUrl: video.url,
      title: video.title,
      durationS: video.durationS,
      transcript: transcript as unknown as Prisma.InputJsonValue,
    },
    update: {
      videoUrl: video.url,
      title: video.title,
      durationS: video.durationS,
      transcript: transcript as unknown as Prisma.InputJsonValue,
    },
  });
}

async function setChannelPullStage(
  db: PrismaClient,
  creatorId: string,
  stage: ActiveChannelPullStage,
  options: ChannelPullOptions,
  extraData: { runId: string; channelUrl?: string },
): Promise<void> {
  const creator = await db.creator.findUniqueOrThrow({
    where: {
      id: creatorId,
    },
    select: {
      channelPullRunId: true,
      channelPullStageAttempts: true,
    },
  });
  if (creator.channelPullRunId !== extraData.runId) {
    throw new WorkflowLeaseLostError("Channel pull", creatorId);
  }

  const updated = await db.creator.updateMany({
    where: {
      id: creatorId,
      channelPullRunId: extraData.runId,
    },
    data: {
      channelUrl: extraData.channelUrl,
      channelPullStage: stage,
      channelPullError: null,
      channelPullLeaseHeartbeatAt: options.now ?? new Date(),
      channelPullStageAttempts: incrementStageAttempt(
        creator.channelPullStageAttempts,
        stage,
      ),
    },
  });
  if (updated.count !== 1) {
    throw new WorkflowLeaseLostError("Channel pull", creatorId);
  }
  await options.onStageChange?.(stage);
}

async function claimChannelPullRun(
  db: PrismaClient,
  creatorId: string,
  runId: string,
  options: ChannelPullOptions,
): Promise<void> {
  await db.creator.update({
    where: {
      id: creatorId,
    },
    data: {
      channelPullRunId: runId,
      channelPullLeaseHeartbeatAt: options.now ?? new Date(),
    },
  });
}

async function heartbeatChannelPullRun(
  db: PrismaClient,
  creatorId: string,
  runId: string,
  options: ChannelPullOptions,
): Promise<void> {
  const updated = await db.creator.updateMany({
    where: {
      id: creatorId,
      channelPullRunId: runId,
    },
    data: {
      channelPullLeaseHeartbeatAt: options.now ?? new Date(),
    },
  });
  if (updated.count !== 1) {
    throw new WorkflowLeaseLostError("Channel pull", creatorId);
  }
}

async function markChannelPullFailed(
  db: PrismaClient,
  creatorId: string,
  runId: string,
  errorText: string,
  options: ChannelPullOptions,
): Promise<void> {
  const updated = await db.creator.updateMany({
    where: {
      id: creatorId,
      channelPullRunId: runId,
    },
    data: {
      channelPullStage: "failed",
      channelPullError: errorText,
      channelPullLeaseHeartbeatAt: options.now ?? new Date(),
    },
  });
  if (updated.count !== 1) {
    throw new WorkflowLeaseLostError("Channel pull", creatorId);
  }
}

function requireMindsClient(
  mindsClient: MindsClient | null | undefined,
): MindsClient {
  const client = mindsClient ?? createMindsClientFromEnv();
  if (!client) {
    throw new Error(`${MINDS_BUILDER_API_KEY_ENV} is required to seed a Mind.`);
  }

  return client;
}

function startChannelPullInBackground(
  creatorId: string,
  channelUrl: string,
  options: ChannelPullApiOptions,
): void {
  const pullImpl = options.pullChannelVoiceImpl ?? pullChannelVoice;
  void pullImpl(creatorId, {
    ...options,
    channelUrl,
  })
    .then((result) => {
      if (result.status === "failed") {
        console.error(`channel pull failed for ${creatorId}: ${result.error}`);
      }
    })
    .catch((error: unknown) => {
      console.error(
        `channel pull crashed for ${creatorId}: ${shortErrorMessage(error)}`,
      );
    });
}

async function readJsonPayload(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ChannelPullInputError(400, "Channel URL is required.");
  }
}

function readChannelUrl(payload: unknown): string {
  if (!isRecord(payload)) {
    throw new ChannelPullInputError(400, "Channel URL is required.");
  }

  const value = payload.channelUrl ?? payload.channel_url;
  if (typeof value !== "string") {
    throw new ChannelPullInputError(400, "Channel URL is required.");
  }
  return value;
}

function channelPullErrorCode(error: unknown): string | null {
  if (error instanceof ClipServiceApiError && error.code === "yt_blocked") {
    return "yt_blocked";
  }
  return null;
}

function channelPullErrorCodeFromText(error: string | null): string | null {
  return error?.includes("yt_blocked") ? "yt_blocked" : null;
}

function channelPullFailureMessage(
  error: unknown,
  errorCode: string | null,
): string {
  if (errorCode === "yt_blocked") {
    return YT_BLOCKED_CHANNEL_PULL_MESSAGE;
  }
  if (error instanceof ChannelPullInputError) {
    return error.message;
  }

  return shortErrorMessage(error);
}

function shortErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message || "Unknown error.").replace(/\s+/g, " ").slice(0, 280);
}

function json(payload: unknown, status: number): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date.`);
  }
}
