import type { InitialTenets } from "../tenets";

export const TENET_SEED_PROMPT_VERSION = "tenet-seed-v1";
export const TENET_VERIFY_PROMPT_VERSION = "tenet-verify-v1";

export function buildTenetSeedMessage(tenets: InitialTenets): string {
  return [
    `Prompt version: ${TENET_SEED_PROMPT_VERSION}`,
    "Store the ClipMind Tenet set below as persistent memory for this creator.",
    "Place it in your Tenets or Covenants memory so it remains available in future conversations.",
    "Update persistent memory first. Do not only summarize the JSON.",
    "Treat it as the creator's voice and clip taste profile only: phrasing, hooks, vocabulary, preferred clip moments, pacing, emotional signals, clip patterns, and creator-specific guardrails.",
    "Do not treat this as product workflow logic, scheduling logic, posting logic, deduplication logic, SEO rules, or backend control flow.",
    "After storing it, briefly confirm the specific voice and clip taste details you will remember.",
    "Tenet JSON:",
    JSON.stringify(tenets, null, 2),
  ].join("\n\n");
}

export function buildTenetVerificationMessage(): string {
  return [
    `Prompt version: ${TENET_VERIFY_PROMPT_VERSION}`,
    "List the current persistent Tenets or Covenants you hold for this creator in 8 bullets or fewer.",
    "Include the remembered voice profile, phrasing habits, hook style, vocabulary, clip taste, and guardrails.",
    "Keep the reply concise and quote only a few specific remembered phrases.",
  ].join("\n\n");
}
