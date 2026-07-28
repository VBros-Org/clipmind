export const RUNWAY_WARNING_THRESHOLD_DAYS = 2;

export type RunwayTone = "calm" | "amber" | "red";

export type RunwayState =
  | {
      kind: "ready";
      clipCount: number;
      slotsPerDay: number;
      days: number;
      tone: RunwayTone;
    }
  | {
      kind: "needs_schedule";
      clipCount: number;
      reason: "no_schedule" | "zero_slots";
    };

export type HomeNudge =
  | {
      id: string;
      kind: "review";
      title: string;
      href: "/review";
    }
  | {
      id: string;
      kind: "runway";
      title: string;
      href: "/upload";
    }
  | {
      id: string;
      kind: "post";
      title: string;
      href: string;
    };

export type HomeNudgeInput = {
  reviewCount: number;
  runway: RunwayState;
  dueClip:
    | {
        clipId: string;
        timeLabel: string;
        isDue: boolean;
      }
    | null
    | undefined;
  runwayWarningThresholdDays?: number;
};

export function computeRunway(
  clipCount: number,
  schedule: { slotsPerDay: number } | null | undefined,
): RunwayState {
  if (!schedule) {
    return {
      kind: "needs_schedule",
      clipCount,
      reason: "no_schedule",
    };
  }

  if (!Number.isFinite(schedule.slotsPerDay) || schedule.slotsPerDay <= 0) {
    return {
      kind: "needs_schedule",
      clipCount,
      reason: "zero_slots",
    };
  }

  const days = clipCount / schedule.slotsPerDay;
  return {
    kind: "ready",
    clipCount,
    slotsPerDay: schedule.slotsPerDay,
    days,
    tone: runwayTone(days),
  };
}

export function runwayTone(days: number): RunwayTone {
  if (days >= 5) {
    return "calm";
  }

  if (days >= RUNWAY_WARNING_THRESHOLD_DAYS) {
    return "amber";
  }

  return "red";
}

export function selectHomeNudges(input: HomeNudgeInput): HomeNudge[] {
  const threshold =
    input.runwayWarningThresholdDays ?? RUNWAY_WARNING_THRESHOLD_DAYS;
  const nudges: HomeNudge[] = [];

  if (input.reviewCount > 0) {
    nudges.push({
      id: `review:${input.reviewCount}`,
      kind: "review",
      title: `${input.reviewCount} ${plural(input.reviewCount, "clip", "clips")} waiting for review`,
      href: "/review",
    });
  }

  if (input.runway.kind === "ready" && input.runway.days < threshold) {
    nudges.push({
      id: `runway:${Math.round(input.runway.days * 10)}:${threshold}`,
      kind: "runway",
      title: `Runway under ${threshold} days. Upload something long.`,
      href: "/upload",
    });
  }

  if (input.dueClip?.isDue) {
    nudges.push({
      id: `post:${input.dueClip.clipId}`,
      kind: "post",
      title: `Clip scheduled for ${input.dueClip.timeLabel} is ready. Post it now.`,
      href: `/review?clip=${encodeURIComponent(input.dueClip.clipId)}`,
    });
  }

  return nudges.slice(0, 3);
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}
