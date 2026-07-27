export interface TranscriptSegment {
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface TranscriptWord {
  start_ms: number;
  end_ms: number;
  word: string;
}

export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
  words: TranscriptWord[];
}

export function parseTranscript(value: unknown): Transcript {
  if (!isRecord(value)) {
    throw new Error("Transcript response must be a JSON object.");
  }

  return {
    text: textField(value, "text"),
    segments: arrayField(value, "segments").map(parseSegment),
    words: arrayField(value, "words").map(parseWord),
  };
}

function parseSegment(value: unknown): TranscriptSegment {
  if (!isRecord(value)) {
    throw new Error("Transcript segment must be a JSON object.");
  }

  return {
    start_ms: numberField(value, "start_ms"),
    end_ms: numberField(value, "end_ms"),
    text: textField(value, "text"),
  };
}

function parseWord(value: unknown): TranscriptWord {
  if (!isRecord(value)) {
    throw new Error("Transcript word must be a JSON object.");
  }

  return {
    start_ms: numberField(value, "start_ms"),
    end_ms: numberField(value, "end_ms"),
    word: textField(value, "word"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array.`);
  }
  return value;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number.`);
  }
  return value;
}

function textField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return value;
}
