import { INITIAL_TENETS_VERSION } from "../tenets";
import type { Transcript } from "../transcript";

export type CorpusSourceType = "existing_clip" | "source_video";

export const CORPUS_WEIGHTS: Record<CorpusSourceType, number> = {
  existing_clip: 3,
  source_video: 1,
};

export interface WeightedTranscript {
  source: string;
  sourceType: CorpusSourceType;
  weight: number;
  transcript: Transcript;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export function buildVoiceDistillMessages(
  transcripts: WeightedTranscript[],
): ChatMessage[] {
  if (transcripts.length === 0) {
    throw new Error("At least one transcript is required for voice distillation.");
  }

  const corpus = [...transcripts]
    .sort((left, right) => right.weight - left.weight)
    .map((item, index) => formatCorpusItem(item, index + 1))
    .join("\n\n");

  return [
    {
      role: "system",
      content: [
        "You distil a creator-specific ClipMind Tenet set from video transcripts.",
        "Tenets may contain only this creator's voice, phrasing, hooks, vocabulary, clip taste, and creator-specific guardrails.",
        "Do not include product workflow rules, posting rules, scheduling, deduplication, ranking method instructions, SEO rules, or backend control logic.",
        "Existing posted clips are highest signal because the creator already chose those moments.",
        "Return valid JSON only.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Prompt version: ${INITIAL_TENETS_VERSION}`,
        "Build this exact JSON shape:",
        JSON.stringify(expectedShape(), null, 2),
        "Corpus items are sorted by weight, highest first. Weight 3 means creator-approved existing clip. Weight 1 means source video or long-form sample.",
        corpus,
      ].join("\n\n"),
    },
  ];
}

function formatCorpusItem(item: WeightedTranscript, index: number): string {
  const segments = item.transcript.segments
    .slice(0, 60)
    .map((segment) => {
      const start = Math.round(segment.start_ms / 1000);
      const end = Math.round(segment.end_ms / 1000);
      return `[${start}s-${end}s] ${segment.text}`;
    })
    .join("\n");

  return [
    `Corpus item ${index}`,
    `source: ${item.source}`,
    `type: ${item.sourceType}`,
    `weight: ${item.weight}`,
    "transcript text:",
    item.transcript.text,
    "segments:",
    segments || "(no segments)",
  ].join("\n");
}

function expectedShape() {
  return {
    version: INITIAL_TENETS_VERSION,
    generatedAt: "ISO-8601 timestamp",
    voiceProfile: {
      sentenceStructure: ["specific observed sentence pattern"],
      phrasingHabits: ["specific repeated phrase or cadence"],
      hookStyle: ["specific opening or escalation style"],
      vocabulary: ["specific recurring word or phrase"],
    },
    clipTasteProfile: {
      preferredMoments: ["specific moment type the creator tends to clip"],
      pacing: ["specific pacing preference"],
      emotionalSignals: ["specific reaction or energy signal"],
      clipPatterns: ["specific setup and payoff pattern"],
    },
    guardrails: ["creator-specific voice or taste constraint"],
  };
}
