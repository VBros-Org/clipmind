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

export interface CreatorRef {
  id: string;
}

export interface OnboardingRepository {
  ensureCreator(args: {
    creatorId?: string;
    channelUrl?: string;
  }): Promise<CreatorRef>;
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

  const transcripts: WeightedTranscript[] = [];
  for (const item of options.corpusItems) {
    transcripts.push({
      source: item.source,
      sourceType: item.sourceType,
      weight: item.weight,
      transcript: await options.transcribeItem(item),
    });
  }

  const tenets = await options.distillTenets(transcripts);

  if (!options.mindsClient) {
    await options.repository.saveInitialTenets(creator.id, tenets);
    return {
      status: "DEFERRED",
      creatorId: creator.id,
      mindId: null,
      tenets,
      transcriptCount: transcripts.length,
      message: MINDS_CREATION_SKIPPED_MESSAGE,
    };
  }

  const mind = await options.mindsClient.createMind(buildMindName(creator.id));
  await options.mindsClient.addTenets(mind.mindId, tenets);
  await options.repository.saveMindIdAndInitialTenets(
    creator.id,
    mind.mindId,
    tenets,
  );

  return {
    status: "PASSED",
    creatorId: creator.id,
    mindId: mind.mindId,
    tenets,
    transcriptCount: transcripts.length,
    message: `Mind created for Creator ${creator.id}`,
  };
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
