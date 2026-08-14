import {
  DEFAULT_ANCHOR_HOUR,
  MAX_ANCHOR_HOUR,
  MAX_SLOTS_PER_DAY,
  MIN_ANCHOR_HOUR,
  MIN_SLOTS_PER_DAY,
  buildEvenSlotTimes,
  normalizeSlotTimes,
  slotTimeParts,
} from "./schedule-settings";
import {
  addCreatorLocalDays,
  creatorLocalDateForInstant,
  creatorLocalDateTimeToUtc,
  resolveCreatorTimezone,
  type CreatorLocalDate,
} from "./timezone";
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
  anchorHour?: number | null;
  slotTimes?: unknown;
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

export function computeNextSlot(
  schedule: SchedulingCadence,
  now: Date,
  timezone?: string | null,
): Date {
  assertValidDate(now, "now");

  const lastScheduledAt = schedule.lastScheduledAt ?? null;
  if (lastScheduledAt) {
    assertValidDate(lastScheduledAt, "lastScheduledAt");
  }

  const explicitSlotTimes = normalizeSlotTimes(schedule.slotTimes);
  const slotTimes = explicitSlotTimes ?? legacySlotTimes(schedule);
  return computeNextCreatorLocalSlot(
    slotTimes,
    now,
    lastScheduledAt,
    timezone,
  );
}

function computeNextCreatorLocalSlot(
  slotTimes: readonly string[],
  now: Date,
  lastScheduledAt: Date | null,
  timezone: string | null | undefined,
): Date {
  const normalizedTimezone = resolveCreatorTimezone(timezone);
  const cursorMs = lastScheduledAt
    ? Math.max(now.getTime(), lastScheduledAt.getTime() + 1)
    : now.getTime();
  const cursorDate = new Date(cursorMs);
  const cursorLocalDate = creatorLocalDateForInstant(
    cursorDate,
    normalizedTimezone,
  );

  for (let dayOffset = 0; dayOffset < 370; dayOffset += 1) {
    const localDate = addCreatorLocalDays(cursorLocalDate, dayOffset);
    for (const slotTime of slotTimes) {
      const slot = slotInstantForLocalDate(
        localDate,
        slotTime,
        normalizedTimezone,
      );
      if (slot.getTime() >= cursorMs) {
        return slot;
      }
    }
  }

  throw new Error("Could not find a future schedule slot.");
}

function legacySlotTimes(schedule: SchedulingCadence): string[] {
  validateSlotsPerDay(schedule.slotsPerDay);
  const anchorHour = schedule.anchorHour ?? DEFAULT_ANCHOR_HOUR;
  validateAnchorHour(anchorHour);
  return buildEvenSlotTimes(schedule.slotsPerDay, anchorHour);
}

function slotInstantForLocalDate(
  localDate: CreatorLocalDate,
  slotTime: string,
  timezone: string,
): Date {
  const { hour, minute } = slotTimeParts(slotTime);
  return creatorLocalDateTimeToUtc(
    {
      ...localDate,
      hour,
      minute,
    },
    timezone,
  );
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

function validateAnchorHour(anchorHour: number): void {
  if (
    !Number.isInteger(anchorHour) ||
    anchorHour < MIN_ANCHOR_HOUR ||
    anchorHour > MAX_ANCHOR_HOUR
  ) {
    throw new Error(
      `anchorHour must be an integer from ${MIN_ANCHOR_HOUR} to ${MAX_ANCHOR_HOUR}.`,
    );
  }
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date.`);
  }
}
