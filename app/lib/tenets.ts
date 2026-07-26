export const INITIAL_TENETS_VERSION = "voice-distill-v1";

export interface InitialTenets {
  version: typeof INITIAL_TENETS_VERSION;
  generatedAt: string;
  voiceProfile: {
    sentenceStructure: string[];
    phrasingHabits: string[];
    hookStyle: string[];
    vocabulary: string[];
  };
  clipTasteProfile: {
    preferredMoments: string[];
    pacing: string[];
    emotionalSignals: string[];
    clipPatterns: string[];
  };
  guardrails: string[];
}

export function parseInitialTenets(value: unknown): InitialTenets {
  const payload = typeof value === "string" ? parseJson(value) : value;
  if (!isRecord(payload)) {
    throw new Error("Tenets response must be a JSON object.");
  }

  assertString(payload.version, "version");
  if (payload.version !== INITIAL_TENETS_VERSION) {
    throw new Error(`Tenets version must be ${INITIAL_TENETS_VERSION}.`);
  }

  assertString(payload.generatedAt, "generatedAt");
  const voiceProfile = recordField(payload, "voiceProfile");
  const clipTasteProfile = recordField(payload, "clipTasteProfile");

  return {
    version: INITIAL_TENETS_VERSION,
    generatedAt: payload.generatedAt,
    voiceProfile: {
      sentenceStructure: stringArrayField(voiceProfile, "sentenceStructure"),
      phrasingHabits: stringArrayField(voiceProfile, "phrasingHabits"),
      hookStyle: stringArrayField(voiceProfile, "hookStyle"),
      vocabulary: stringArrayField(voiceProfile, "vocabulary"),
    },
    clipTasteProfile: {
      preferredMoments: stringArrayField(clipTasteProfile, "preferredMoments"),
      pacing: stringArrayField(clipTasteProfile, "pacing"),
      emotionalSignals: stringArrayField(clipTasteProfile, "emotionalSignals"),
      clipPatterns: stringArrayField(clipTasteProfile, "clipPatterns"),
    },
    guardrails: stringArrayField(payload, "guardrails"),
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error("Tenets response must be valid JSON.", { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`${key} must be a JSON object.`);
  }
  return value;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array of strings.`);
  }

  const cleaned = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${key} must contain only non-empty strings.`);
    }
    return item.trim();
  });

  if (cleaned.length === 0) {
    throw new Error(`${key} must contain at least one item.`);
  }

  return cleaned;
}

function assertString(value: unknown, key: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string.`);
  }
}
