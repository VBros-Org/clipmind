export const RANK_CLIPS_PROMPT_VERSION = "rank-clips-v1";

export type RankClipPromptCandidate = {
  index: number;
  durationMs: number;
  transcript: string | null;
};

export function buildRankClipsMessage(
  candidates: readonly RankClipPromptCandidate[],
): string {
  return [
    `Prompt version: ${RANK_CLIPS_PROMPT_VERSION}`,
    "Rank these candidate clip windows by this creator's remembered clip taste.",
    "Use only the creator-specific voice and taste profile you hold in memory.",
    "Do not apply scheduling, posting, deduplication, or workflow rules.",
    "Reply ONLY with a JSON array, best-first, with one object per candidate:",
    '[{"index":2,"reason":"specific taste-based reason"}]',
    "Rules:",
    "Use each listed index exactly once.",
    "The index must be a number from the candidate list.",
    "Keep each reason short and specific to the creator's taste.",
    "Do not include prose, Markdown, HTML, IDs, status changes, or extra keys.",
    "Candidates:",
    candidates.map(formatCandidate).join("\n\n"),
  ].join("\n\n");
}

function formatCandidate(candidate: RankClipPromptCandidate): string {
  return [
    `${candidate.index}. duration=${formatDuration(candidate.durationMs)}`,
    "transcript span:",
    candidate.transcript?.trim() || "(no transcript provided)",
  ].join("\n");
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}
