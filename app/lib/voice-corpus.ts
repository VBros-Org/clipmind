import type { Prisma, PrismaClient } from "@prisma/client";

import { normalizeCaptionCorpus } from "./caption-corpus";
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
import { parseTranscript } from "./transcript";
import { newWorkflowRunId } from "./workflow-lease";

export type VoiceCorpusOptions = {
  prismaClient?: PrismaClient;
  mindsClient?: MindsClient | null;
  distillTenets?: (
    transcripts: WeightedTranscript[],
    evidence?: VoiceDistillEvidence,
  ) => Promise<InitialTenets>;
  now?: Date;
  adoptionPollMs?: number;
  maxAdoptionWaitMs?: number;
};

export type VoiceCorpusResult = {
  creatorId: string;
  captionCorpus: string | null;
  captionCount: number;
};

export type TeachVoiceResult = VoiceCorpusResult & {
  mindId: string;
  tenets: InitialTenets;
  confirmation: string;
};

class VoiceCorpusApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function handleSaveCaptionCorpus(
  request: Request,
  options: VoiceCorpusOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  try {
    const result = await saveCaptionCorpusForCreator(
      session.creatorId,
      readCaptionCorpus(await readJsonPayload(request)),
      options,
    );
    return json(result, 200);
  } catch (error) {
    return voiceCorpusErrorResponse(error);
  }
}

export async function handleTeachVoice(
  request: Request,
  options: VoiceCorpusOptions = {},
): Promise<Response> {
  const session = await loadCreatorSession(request, options);
  if (!session) {
    return json({ error: "Login required." }, 401);
  }

  try {
    const result = await teachCreatorVoiceFromCaptionCorpus(
      session.creatorId,
      readCaptionCorpus(await readJsonPayload(request)),
      options,
    );
    return json(
      {
        creatorId: result.creatorId,
        captionCorpus: result.captionCorpus,
        captionCount: result.captionCount,
        mindId: result.mindId,
        confirmation: result.confirmation,
      },
      200,
    );
  } catch (error) {
    return voiceCorpusErrorResponse(error);
  }
}

export async function saveCaptionCorpusForCreator(
  creatorId: string,
  rawCaptionCorpus: unknown,
  options: VoiceCorpusOptions = {},
): Promise<VoiceCorpusResult> {
  const normalized = normalizeCaptionCorpus(rawCaptionCorpus);
  const db = options.prismaClient ?? prisma;

  await db.creator.update({
    where: {
      id: creatorId,
    },
    data: {
      captionCorpus: normalized.captionCorpus,
    },
  });

  return {
    creatorId,
    captionCorpus: normalized.captionCorpus,
    captionCount: normalized.captionCount,
  };
}

export async function teachCreatorVoiceFromCaptionCorpus(
  creatorId: string,
  rawCaptionCorpus: unknown,
  options: VoiceCorpusOptions = {},
): Promise<TeachVoiceResult> {
  const db = options.prismaClient ?? prisma;
  const normalized = await saveCaptionCorpusForCreator(
    creatorId,
    rawCaptionCorpus,
    {
      prismaClient: db,
    },
  );
  const transcripts = await loadCreatorTranscriptEvidence(db, creatorId);
  if (transcripts.length === 0 && !normalized.captionCorpus) {
    throw new VoiceCorpusApiError(
      400,
      "Paste captions or upload a video first.",
    );
  }

  const distillTenets = options.distillTenets ?? createOpenAITenetDistiller();
  const tenets = await distillTenets(transcripts, {
    captionCorpus: normalized.captionCorpus,
  });
  const mindsClient = options.mindsClient ?? createMindsClientFromEnv();
  if (!mindsClient) {
    throw new VoiceCorpusApiError(
      503,
      `${MINDS_BUILDER_API_KEY_ENV} is required to teach your Mind.`,
    );
  }
  const mind = await ensureCreatorMind({
    db,
    creatorId,
    runId: newWorkflowRunId("voice-corpus"),
    workflowName: "Voice corpus",
    mindsClient,
    now: options.now,
    adoptionPollMs: options.adoptionPollMs,
    maxAdoptionWaitMs: options.maxAdoptionWaitMs,
  });

  const now = options.now ?? new Date();
  assertValidDate(now, "now");
  const confirmation = await seedCreatorTenets(mindsClient, mind.mindId, tenets, {
    alias: buildVoiceReseedAlias(creatorId, now),
    action: "Voice corpus Tenet seed",
  });

  await db.creator.update({
    where: {
      id: creatorId,
    },
    data: {
      captionCorpus: normalized.captionCorpus,
      initialTenets: tenets as unknown as Prisma.InputJsonValue,
      mindId: mind.mindId,
      mindStage: "ready",
      mindError: null,
    },
  });

  return {
    creatorId,
    captionCorpus: normalized.captionCorpus,
    captionCount: normalized.captionCount,
    mindId: mind.mindId,
    tenets,
    confirmation,
  };
}

export function buildVoiceReseedAlias(creatorId: string, now: Date): string {
  assertValidDate(now, "now");
  const shortCreatorId =
    creatorId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "creator";
  const stamp = `${now.toISOString().slice(0, 10).replace(/-/g, "")}${now
    .toISOString()
    .slice(11, 19)
    .replace(/:/g, "")}`;

  return `clipmind-voice-${shortCreatorId}-${stamp}`.slice(0, 64);
}

export function loadCreatorTranscriptEvidence(
  db: PrismaClient,
  creatorId: string,
): Promise<WeightedTranscript[]> {
  return Promise.all([
    db.clip.findMany({
      where: {
        creatorId,
        transcript: {
          not: null,
        },
      },
      orderBy: [
        {
          createdAt: "desc",
        },
        {
          id: "asc",
        },
      ],
      take: 20,
      select: {
        id: true,
        status: true,
        startMs: true,
        endMs: true,
        transcript: true,
      },
    }),
    db.channelPullTranscript.findMany({
      where: {
        creatorId,
      },
      orderBy: [
        {
          createdAt: "desc",
        },
        {
          id: "asc",
        },
      ],
      take: 20,
      select: {
        videoId: true,
        transcript: true,
      },
    }),
  ]).then(([clips, channelPullTranscripts]) => [
    ...clips.map((clip) => {
      const approved = isCreatorApprovedStatus(clip.status);
      const sourceType = approved
        ? ("existing_clip" as const)
        : ("source_video" as const);
      const transcriptText = clip.transcript ?? "";

      return {
        source: `clip:${clip.id}`,
        sourceType,
        weight: CORPUS_WEIGHTS[sourceType],
        transcript: {
          text: transcriptText,
          segments: [
            {
              start_ms: clip.startMs,
              end_ms: clip.endMs,
              text: transcriptText,
            },
          ],
          words: [],
        },
      };
    }),
    ...channelPullTranscripts.map((item) => ({
      source: `youtube:${item.videoId}`,
      sourceType: "source_video" as const,
      weight: CORPUS_WEIGHTS.source_video,
      transcript: parseTranscript(item.transcript),
    })),
  ]);
}

function isCreatorApprovedStatus(status: string): boolean {
  return status === "accepted" || status === "scheduled" || status === "posted";
}

async function loadCreatorSession(
  request: Request,
  options: VoiceCorpusOptions,
) {
  return loadCreatorSessionFromCookieHeader(
    request.headers.get("cookie"),
    options,
  );
}

async function readJsonPayload(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new VoiceCorpusApiError(400, "Caption corpus is required.");
  }
}

function readCaptionCorpus(payload: unknown): string {
  if (!isRecord(payload) || typeof payload.captionCorpus !== "string") {
    throw new VoiceCorpusApiError(400, "Caption corpus must be text.");
  }

  return payload.captionCorpus;
}

function voiceCorpusErrorResponse(error: unknown): Response {
  if (error instanceof VoiceCorpusApiError) {
    return json({ error: error.message }, error.status);
  }
  if (error instanceof Error && error.message === "Caption corpus must be text.") {
    return json({ error: error.message }, 400);
  }

  throw error;
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
