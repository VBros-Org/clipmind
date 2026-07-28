export const SCHEDULE_ANCHOR_HOUR_UTC = 9;

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_SLOTS_PER_DAY = 1;
const MAX_SLOTS_PER_DAY = 24;

export type ClipSchedulingStatus =
  | "candidate"
  | "accepted"
  | "rejected"
  | "scheduled"
  | "posted";

export interface SchedulingClip {
  id: string;
  videoId: string;
  startMs: number;
  endMs: number;
  status: ClipSchedulingStatus;
  createdAt: Date;
  acceptedAt?: Date | null;
}

export interface SchedulingHistoryClip {
  id: string;
  videoId: string;
  startMs: number;
  endMs: number;
  status: ClipSchedulingStatus;
  createdAt: Date;
  scheduledFor?: Date | null;
  postedAt?: Date | null;
}

export interface SchedulingCadence {
  slotsPerDay: number;
  lastScheduledAt?: Date | null;
}

export const CLIP_STATUS_TRANSITIONS: Record<
  ClipSchedulingStatus,
  readonly ClipSchedulingStatus[]
> = {
  candidate: ["accepted", "rejected"],
  accepted: ["scheduled"],
  rejected: [],
  scheduled: ["posted"],
  posted: [],
};

export function assertClipStatusTransition(
  from: ClipSchedulingStatus,
  to: ClipSchedulingStatus,
): void {
  if (!CLIP_STATUS_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid clip status transition ${from}->${to}.`);
  }
}

export function toClipSchedulingStatus(status: string): ClipSchedulingStatus {
  switch (status) {
    case "candidate":
    case "accepted":
    case "rejected":
    case "scheduled":
    case "posted":
      return status;
    default:
      throw new Error(`Unknown clip status ${status}.`);
  }
}

export function pickNextClip(
  candidates: readonly SchedulingClip[],
  recentHistory: readonly SchedulingHistoryClip[],
): SchedulingClip | null {
  const scheduledOrPostedHistory = recentHistory.filter((clip) =>
    isScheduledOrPosted(clip.status),
  );
  const usedClipIds = new Set(scheduledOrPostedHistory.map((clip) => clip.id));
  const usedWindows = new Set(
    scheduledOrPostedHistory.map((clip) => dedupKey(clip)),
  );

  const eligibleClips = candidates
    .filter((clip) => clip.status === "accepted")
    .filter((clip) => !usedClipIds.has(clip.id))
    .filter((clip) => !usedWindows.has(dedupKey(clip)))
    .sort(compareAcceptedAge);

  if (eligibleClips.length === 0) {
    return null;
  }

  const clipsByVideo = new Map<string, SchedulingClip[]>();
  for (const clip of eligibleClips) {
    const clips = clipsByVideo.get(clip.videoId) ?? [];
    clips.push(clip);
    clipsByVideo.set(clip.videoId, clips);
  }

  const lastServedAtByVideo = new Map<string, Date>();
  for (const clip of scheduledOrPostedHistory) {
    const servedAt = historyServedAt(clip);
    const previous = lastServedAtByVideo.get(clip.videoId);
    if (!previous || servedAt.getTime() > previous.getTime()) {
      lastServedAtByVideo.set(clip.videoId, servedAt);
    }
  }

  const [nextVideoId, nextVideoClips] = [...clipsByVideo.entries()].sort(
    ([leftVideoId, leftClips], [rightVideoId, rightClips]) => {
      const leftServedAt = lastServedAtByVideo.get(leftVideoId);
      const rightServedAt = lastServedAtByVideo.get(rightVideoId);

      if (!leftServedAt && rightServedAt) {
        return -1;
      }
      if (leftServedAt && !rightServedAt) {
        return 1;
      }
      if (leftServedAt && rightServedAt) {
        const servedDiff = leftServedAt.getTime() - rightServedAt.getTime();
        if (servedDiff !== 0) {
          return servedDiff;
        }
      }

      const clipDiff = compareAcceptedAge(leftClips[0], rightClips[0]);
      if (clipDiff !== 0) {
        return clipDiff;
      }

      return leftVideoId.localeCompare(rightVideoId);
    },
  )[0];

  if (!nextVideoId) {
    return null;
  }

  return nextVideoClips[0] ?? null;
}

// Cadence is UTC and intentionally simple for T6:
// slotsPerDay creates evenly spaced slots from a fixed 09:00 UTC anchor.
export function computeNextSlot(
  schedule: SchedulingCadence,
  now: Date,
): Date {
  assertValidDate(now, "now");
  validateSlotsPerDay(schedule.slotsPerDay);

  const lastScheduledAt = schedule.lastScheduledAt ?? null;
  if (lastScheduledAt) {
    assertValidDate(lastScheduledAt, "lastScheduledAt");
  }

  const intervalMs = DAY_MS / schedule.slotsPerDay;
  if (!Number.isInteger(intervalMs)) {
    throw new Error("slotsPerDay must divide one UTC day into whole milliseconds.");
  }

  const cursorMs = lastScheduledAt
    ? Math.max(now.getTime(), lastScheduledAt.getTime() + 1)
    : now.getTime();
  const anchorMs = Date.UTC(1970, 0, 1, SCHEDULE_ANCHOR_HOUR_UTC);
  const slotsSinceAnchor = Math.ceil((cursorMs - anchorMs) / intervalMs);

  return new Date(anchorMs + slotsSinceAnchor * intervalMs);
}

function compareAcceptedAge(
  left: SchedulingClip,
  right: SchedulingClip,
): number {
  const acceptedDiff = acceptedAt(left).getTime() - acceptedAt(right).getTime();
  if (acceptedDiff !== 0) {
    return acceptedDiff;
  }

  return left.id.localeCompare(right.id);
}

function acceptedAt(clip: SchedulingClip): Date {
  return clip.acceptedAt ?? clip.createdAt;
}

function historyServedAt(clip: SchedulingHistoryClip): Date {
  if (clip.status === "posted" && clip.postedAt) {
    return clip.postedAt;
  }

  if (clip.scheduledFor) {
    return clip.scheduledFor;
  }

  return clip.createdAt;
}

function isScheduledOrPosted(status: ClipSchedulingStatus): boolean {
  return status === "scheduled" || status === "posted";
}

function dedupKey(clip: {
  videoId: string;
  startMs: number;
  endMs: number;
}): string {
  return JSON.stringify([clip.videoId, clip.startMs, clip.endMs]);
}

function validateSlotsPerDay(slotsPerDay: number): void {
  if (
    !Number.isInteger(slotsPerDay) ||
    slotsPerDay < MIN_SLOTS_PER_DAY ||
    slotsPerDay > MAX_SLOTS_PER_DAY
  ) {
    throw new Error(
      `slotsPerDay must be an integer from ${MIN_SLOTS_PER_DAY} to ${MAX_SLOTS_PER_DAY}.`,
    );
  }
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date.`);
  }
}
