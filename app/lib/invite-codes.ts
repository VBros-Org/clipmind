import { randomInt } from "node:crypto";

const WORDS = [
  "arcade",
  "boost",
  "camera",
  "combo",
  "drift",
  "focus",
  "glow",
  "hook",
  "level",
  "loop",
  "moment",
  "neon",
  "pixel",
  "pulse",
  "queue",
  "replay",
  "signal",
  "spark",
  "tempo",
  "vault",
  "voice",
  "window",
  "winner",
  "zoom",
];

export function normalizeInviteCode(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

export function generateReadableInviteCode(): string {
  return [
    WORDS[randomInt(WORDS.length)],
    WORDS[randomInt(WORDS.length)],
    WORDS[randomInt(WORDS.length)],
  ].join("-");
}
