export const CAPTION_CLIP_PROMPT_VERSION = "caption-clip-v1";

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
    "Per-platform norms:",
    "youtube: YouTube Shorts title style. Hook-led, searchable, under 100 characters. No hashtags.",
    "tiktok: Conversational social caption. Strong first beat, natural creator voice, 2 to 4 specific hashtags at the end.",
    "instagram: Reels caption. First line must carry the watch-or-scroll hook, then 2 to 4 tight relevant hashtags.",
    "",
    "Hashtag rules for TikTok and Instagram:",
    "Use a few specific tags tied to the game, topic, object, or moment when known.",
    "Prefer concrete tags like a game name, challenge, fail, clutch, recipe, guide, or named subject.",
    "Never use #fyp, #viral, #trending, or filler tags like #Gaming, #Streamer, #GamerLife, #Content, #ContentCreator.",
    "If the game or topic is unknown, keep hashtags moment-specific or use none.",
    "",
    "Platform safety:",
    "Gaming words are safe: die, died, dead, death, kill, killed, killing, zombie, shoot, murder.",
    "Never censor safe gaming words with algospeak like unalive. It reads as slop.",
    "Ban sexual or anatomy words, sexual innuendo, eggplant or water-droplet emoji, real f-word variants, and slurs from every variant.",
    "If the transcript or context contains banned-tier words, write around them and keep the moment understandable.",
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
