export const CAPTION_CLIP_PROMPT_VERSION = "caption-clip-v2";

export type CaptionClipPromptInput = {
  durationMs: number;
  transcript: string | null;
  videoContext: string | null;
};

const MAX_TRANSCRIPT_CHARS = 2_400;
const MAX_CONTEXT_CHARS = 1_200;

export function buildCaptionClipMessage(
  input: CaptionClipPromptInput,
): string {
  return [
    `Prompt version: ${CAPTION_CLIP_PROMPT_VERSION}`,
    "Write platform post-copy for this clip in this creator's remembered voice.",
    "This is the platform caption or title the creator will paste when posting.",
    "Do not write burned-in subtitles. Do not write scheduling, ranking, status, or workflow output.",
    "Use the creator-specific voice and clip taste you hold in memory. Do not invent a fixed creator persona from these instructions.",
    "The backend owns the product rules below. Follow them exactly while keeping the creator's remembered cadence and phrasing.",
    "",
    "Reply ONLY with a JSON object using exactly these keys:",
    '{"youtube":"...","tiktok":"...","instagram":"..."}',
    "All three values must be non-empty strings. No Markdown, HTML, comments, wrappers, or extra prose.",
    "",
    "Per-platform norms, creator generic:",
    "youtube: Video title for a YouTube Short. Clickable and searchable. Lead with the hook. Work in a searchable word where it fits. Max 100 chars, aim 55 to 80. No hashtags.",
    "tiktok: Social caption. Reactive creator voice, strong first 3 seconds hook. End with 3 to 5 specific hashtags.",
    "instagram: Reels caption. Put a strong hook in the first line because it decides watch-or-scroll. Then add a line of story or context beyond the hook. Instagram gets more room than TikTok. Put a line break between the thought and tags. End with 3 to 5 relevant hashtags max because hashtags barely move reach on Instagram, keep them tight and specific.",
    "Do not make Instagram just the TikTok caption with one extra opener. TikTok and Instagram need different platform shapes, not copied bodies.",
    "",
    "Hashtag rules for TikTok and Instagram:",
    "Always include the game or topic tag from the known clip data. If the exact game is unknown, use the clearest topic tag and do not invent a game name.",
    "Use content-specific tags tied to the specific moment, item, object, challenge, fail, clutch, recipe, guide, or named subject.",
    "Never use generic filler like #Gaming, #Streamer, #Content, #fyp, #viral, #trending, #GamerLife, or #ContentCreator.",
    "",
    "Platform safety for all three variants:",
    "Violence and gaming words are safe: die, died, dead, death, kill, killed, killing, zombie, shoot, murder.",
    "Never algospeak-censor safe gaming words. Do not write unalive.",
    "Banned everywhere: sexual or anatomy words, sexual innuendo, sexual emoji, real f-word in any spelling, and slurs.",
    "If the transcript or context contains banned words, write around them while keeping the moment funny and understandable.",
    "For Instagram, death can be mentioned plainly, but do not make gore itself the punchline.",
    "",
    "Anti-slop rules:",
    "No em dash or en dash characters. Use a comma, a hyphen, or a short sentence.",
    'No "not just X, but Y" negative parallelism.',
    "No forced rule-of-three cadence. One specific detail beats a balanced list.",
    "No model-favored vocab clusters: delve, tapestry, intricate, underscore, boasts, testament, elevate.",
    "No trailing depth tags that end in -ing and add no concrete fact.",
    'Prefer plain is, are, and has over "serves as", "features", or "boasts".',
    "Strip ceremony and earned-importance. State the thing.",
    "Straight quotes only.",
    "",
    "Clip data:",
    `duration=${formatDuration(input.durationMs)}`,
    "video context:",
    fence("VIDEO_CONTEXT", truncate(input.videoContext, MAX_CONTEXT_CHARS)),
    "transcript:",
    fence("TRANSCRIPT", truncate(input.transcript, MAX_TRANSCRIPT_CHARS)),
  ].join("\n");
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
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

function fence(label: string, value: string): string {
  return `<<<${label}\n${value}\n${label}>>>`;
}
