export const MAX_CAPTION_CORPUS_LINES = 20;
export const MAX_CAPTION_CORPUS_CHARS = 4_000;

export type NormalizedCaptionCorpus = {
  captionCorpus: string | null;
  captionCount: number;
};

export function normalizeCaptionCorpus(value: unknown): NormalizedCaptionCorpus {
  if (value === null || value === undefined) {
    return {
      captionCorpus: null,
      captionCount: 0,
    };
  }

  if (typeof value !== "string") {
    throw new Error("Caption corpus must be text.");
  }

  const captions: string[] = [];
  let totalChars = 0;
  const rawLines = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");

  for (const rawLine of rawLines) {
    if (captions.length >= MAX_CAPTION_CORPUS_LINES) {
      break;
    }

    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const separatorChars = captions.length === 0 ? 0 : 1;
    const remainingChars =
      MAX_CAPTION_CORPUS_CHARS - totalChars - separatorChars;
    if (remainingChars <= 0) {
      break;
    }

    const clippedLine =
      line.length > remainingChars ? line.slice(0, remainingChars).trimEnd() : line;
    if (!clippedLine) {
      break;
    }

    captions.push(clippedLine);
    totalChars += separatorChars + clippedLine.length;
  }

  return {
    captionCorpus: captions.length > 0 ? captions.join("\n") : null,
    captionCount: captions.length,
  };
}

export function countCaptionCorpusLines(value: string | null | undefined): number {
  return normalizeCaptionCorpus(value ?? null).captionCount;
}

export function capCaptionCorpusInput(value: string): string {
  return value
    .slice(0, MAX_CAPTION_CORPUS_CHARS)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .slice(0, MAX_CAPTION_CORPUS_LINES)
    .join("\n");
}

export function captionCorpusSummary(value: string | null | undefined): {
  captionCorpus: string;
  captionCount: number;
} {
  return {
    captionCorpus: value ?? "",
    captionCount: countCaptionCorpusLines(value),
  };
}
