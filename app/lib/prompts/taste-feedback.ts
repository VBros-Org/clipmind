export const TASTE_FEEDBACK_PROMPT_VERSION = "taste-feedback-v1";

export type TasteFeedbackPromptClip = {
  transcriptSnippet: string | null;
  durationMs: number;
  mindRank: number | null;
  mindRankReason: string | null;
};

export type TasteFeedbackPromptInput = {
  accepted: readonly TasteFeedbackPromptClip[];
  rejected: readonly TasteFeedbackPromptClip[];
};

const MAX_TRANSCRIPT_SNIPPET_CHARS = 700;
const MAX_REASON_CHARS = 500;

export function buildTasteFeedbackMessage(
  input: TasteFeedbackPromptInput,
): string {
  return [
    `Prompt version: ${TASTE_FEEDBACK_PROMPT_VERSION}`,
    "These are verdict facts from this creator's review session.",
    "Update only this creator's clip-taste Priors: what to seek more of and what to avoid next time.",
    "Do not touch the creator's voice profile, caption style, safety guardrails, or workflow rules.",
    "Do not change clip statuses, rankings, captions, schedules, or any past output. The backend owns those fields.",
    "Accepted clips are positive taste signals. Rejected clips are negative taste signals.",
    "Use the Mind's original rank and reason as context, but let the human verdict override it as taste feedback.",
    "Reply in plain text with 1 to 3 short sentences confirming what you adjusted. No JSON, no Markdown.",
    "",
    "Accepted clips:",
    formatClipList(input.accepted),
    "",
    "Rejected clips:",
    formatClipList(input.rejected),
  ].join("\n");
}

function formatClipList(clips: readonly TasteFeedbackPromptClip[]): string {
  if (clips.length === 0) {
    return "(none)";
  }

  return clips.map(formatClip).join("\n\n");
}

function formatClip(clip: TasteFeedbackPromptClip, index: number): string {
  return [
    `${index + 1}. duration=${formatDuration(clip.durationMs)}`,
    `mindRank=${clip.mindRank ?? "unranked"}`,
    "original Mind reason:",
    truncate(clip.mindRankReason, MAX_REASON_CHARS),
    "transcript snippet:",
    truncate(clip.transcriptSnippet, MAX_TRANSCRIPT_SNIPPET_CHARS),
  ].join("\n");
}

function formatDuration(durationMs: number): string {
  return `${(Math.max(0, durationMs) / 1000).toFixed(1)}s`;
}

function truncate(value: string | null, maxChars: number): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "(none provided)";
  }

  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxChars)}...`;
}
