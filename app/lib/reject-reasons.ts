export const REJECT_REASONS = [
  "not my style",
  "weak moment",
  "bad clip window",
  "wrong vibe",
] as const;

export type RejectReason = (typeof REJECT_REASONS)[number];

export function isRejectReason(value: unknown): value is RejectReason {
  return REJECT_REASONS.includes(value as RejectReason);
}
