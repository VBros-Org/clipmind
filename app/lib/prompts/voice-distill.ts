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

export interface VoiceDistillEvidence {
  captionCorpus?: string | null;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export function buildVoiceDistillMessages(
  transcripts: WeightedTranscript[],
  evidence: VoiceDistillEvidence = {},
): ChatMessage[] {
  const captionCorpus = cleanCaptionCorpus(evidence.captionCorpus);
  if (transcripts.length === 0 && !captionCorpus) {
    throw new Error("At least one transcript is required for voice distillation.");
  }

  const corpus = [...transcripts]
    .sort((left, right) => right.weight - left.weight)
    .map((item, index) => formatCorpusItem(item, index + 1))
    .join("\n\n");
  const systemLines = [
    "You distil a creator-specific ClipMind Tenet set from video transcripts.",
    "Tenets may contain only this creator's voice, phrasing, hooks, vocabulary, clip taste, and creator-specific guardrails.",
    "Do not include product workflow rules, posting rules, scheduling, deduplication, ranking method instructions, SEO rules, or backend control logic.",
    "Existing posted clips are highest signal because the creator already chose those moments.",
  ];
  const userLines = [
    `Prompt version: ${INITIAL_TENETS_VERSION}`,
    "Build this exact JSON shape:",
    JSON.stringify(expectedShape(), null, 2),
    "Corpus items are sorted by weight, highest first. Weight 3 means creator-approved existing clip. Weight 1 means source video or long-form sample.",
  ];

  if (captionCorpus) {
    systemLines.push(
      "Written post-copy captions are primary evidence for caption voice: hooks, slang, rhythm, punctuation, and line shape.",
      "Video transcripts remain primary evidence for spoken voice, creator taste, and which moments feel clippable.",
    );
    userLines.push(
      "Caption corpus, one recent post-copy caption per line:",
      formatCaptionCorpus(captionCorpus),
    );
  }

  userLines.push(corpus || "Transcript corpus: (none provided)");
  systemLines.push("Return valid JSON only.");

  return [
    {
      role: "system",
      content: systemLines.join("\n"),
    },
    {
      role: "user",
      content: userLines.join("\n\n"),
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

function formatCaptionCorpus(captionCorpus: string): string {
  return captionCorpus
    .split("\n")
    .map((caption, index) => `Caption ${index + 1}: ${caption}`)
    .join("\n");
}

function cleanCaptionCorpus(value: string | null | undefined): string | null {
  const clean = value?.trim();
  return clean ? clean : null;
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
