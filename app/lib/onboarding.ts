import {
  CORPUS_WEIGHTS,
  type CorpusSourceType,
  type WeightedTranscript,
} from "./prompts/voice-distill";
import type { CorpusItem } from "./clip-service";
import {
  MINDS_CREATION_SKIPPED_MESSAGE,
  type MindsClient,
} from "./minds";
import type { InitialTenets } from "./tenets";
import type { Transcript } from "./transcript";

export const DEFAULT_CREATOR_STEWARD_EMAIL = "georgebracher23@gmail.com";

export interface CreatorRef {
  id: string;
}

export interface OnboardingRepository {
  ensureCreator(args: {
    creatorId?: string;
    channelUrl?: string;
  }): Promise<CreatorRef>;
  saveMindId(creatorId: string, mindId: string): Promise<void>;
  saveInitialTenets(creatorId: string, tenets: InitialTenets): Promise<void>;
  saveMindIdAndInitialTenets(
    creatorId: string,
    mindId: string,
    tenets: InitialTenets,
  ): Promise<void>;
}

export interface CreatorOnboardingOptions {
  creatorId?: string;
  channelUrl?: string;
  stewardEmail?: string;
  corpusItems: CorpusItem[];
  repository: OnboardingRepository;
  transcribeItem(item: CorpusItem): Promise<Transcript>;
  distillTenets(transcripts: WeightedTranscript[]): Promise<InitialTenets>;
  mindsClient: MindsClient | null;
}

export interface CreatorOnboardingResult {
  status: "PASSED" | "DEFERRED";
  creatorId: string;
  mindId: string | null;
  mindEmail: string | null;
  verifyTenetsReply: string | null;
  tenets: InitialTenets;
  transcriptCount: number;
  message: string;
}

export async function onboardCreator(
  options: CreatorOnboardingOptions,
): Promise<CreatorOnboardingResult> {
  if (options.corpusItems.length === 0) {
    throw new Error("At least one corpus item is required.");
  }

  const creator = await options.repository.ensureCreator({
    creatorId: options.creatorId,
    channelUrl: options.channelUrl,
  });

  const transcripts = await transcribeCorpusItems(
    options.corpusItems,
    options.transcribeItem,
  );
  const tenets = await distillCorpusTenets(transcripts, options.distillTenets);

  if (!options.mindsClient) {
    await options.repository.saveInitialTenets(creator.id, tenets);
    return {
      status: "DEFERRED",
      creatorId: creator.id,
      mindId: null,
      mindEmail: null,
      verifyTenetsReply: null,
      tenets,
      transcriptCount: transcripts.length,
      message: MINDS_CREATION_SKIPPED_MESSAGE,
    };
  }

  const stewardEmail =
    options.stewardEmail?.trim() || DEFAULT_CREATOR_STEWARD_EMAIL;
  const mind = await createCreatorMind({
    creatorId: creator.id,
    stewardEmail,
    mindsClient: options.mindsClient,
  });
  await options.repository.saveMindId(creator.id, mind.mindId);
  await seedCreatorTenets(options.mindsClient, mind.mindId, tenets);
  await options.repository.saveMindIdAndInitialTenets(
    creator.id,
    mind.mindId,
    tenets,
  );
  const verifyTenetsReply = await verifyCreatorTenets(
    options.mindsClient,
    mind.mindId,
  );

  return {
    status: "PASSED",
    creatorId: creator.id,
    mindId: mind.mindId,
    mindEmail: mind.mindEmail,
    verifyTenetsReply,
    tenets,
    transcriptCount: transcripts.length,
    message: `Mind created for Creator ${creator.id}`,
  };
}

export async function transcribeCorpusItems(
  corpusItems: CorpusItem[],
  transcribeItem: (item: CorpusItem) => Promise<Transcript>,
): Promise<WeightedTranscript[]> {
  const transcripts: WeightedTranscript[] = [];
  for (const item of corpusItems) {
    transcripts.push({
      source: item.source,
      sourceType: item.sourceType,
      weight: item.weight,
      transcript: await transcribeItem(item),
    });
  }

  return transcripts;
}

export function distillCorpusTenets(
  transcripts: WeightedTranscript[],
  distillTenets: (transcripts: WeightedTranscript[]) => Promise<InitialTenets>,
): Promise<InitialTenets> {
  return distillTenets(transcripts);
}

export function createCreatorMind(args: {
  creatorId: string;
  stewardEmail?: string;
  mindsClient: MindsClient;
}): Promise<{
  mindId: string;
  mindEmail: string;
}> {
  return args.mindsClient.createMind(
    buildMindName(args.creatorId),
    args.stewardEmail?.trim() || DEFAULT_CREATOR_STEWARD_EMAIL,
  );
}

export function seedCreatorTenets(
  mindsClient: MindsClient,
  mindId: string,
  tenets: InitialTenets,
): Promise<void> {
  return mindsClient.addTenets(mindId, tenets);
}

export function verifyCreatorTenets(
  mindsClient: MindsClient,
  mindId: string,
): Promise<string> {
  return mindsClient.verifyTenets(mindId);
}

export function buildMindName(creatorId: string): string {
  const suffix = creatorId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "creator";
  return `ClipMind ${suffix}`.slice(0, 20);
}

export function corpusItemFromSource(
  source: string,
  sourceType: CorpusSourceType,
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
