import {
  DEFAULT_RUNWAY_THRESHOLD_DAYS,
  slotCountForSchedule,
} from "./schedule-settings";
import {
  failedUploadNudgeTitle,
  failedUploadTitle,
} from "./upload-stage-copy";
import { formatCreatorLocalTime } from "./timezone";

export const RUNWAY_WARNING_THRESHOLD_DAYS = DEFAULT_RUNWAY_THRESHOLD_DAYS;

export type NudgeKind =
  | "review"
  | "runway"
  | "post"
  | "failed"
  | "pipeline_done";
export type RunwayTone = "refill" | "calm" | "amber" | "red";
export type HomeNudgeDismissal = "persistent" | "session";

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

export type NudgeSchedule = {
  slotsPerDay: number;
  slotTimes?: readonly string[] | null;
  reviewReminders: boolean;
  runwayWarnings: boolean;
  runwayThresholdDays: number;
  postTimeNudges: boolean;
  pushNudges?: boolean;
} | null;

export type NudgeCreatorState = {
  id: string;
  timezone?: string | null;
  reviewCount: number;
  queuedClipCount: number;
  schedule: NudgeSchedule;
  scheduledClips: readonly NudgeScheduledClip[];
  failedVideos?: readonly NudgeFailedVideo[];
  doneVideos?: readonly NudgeDoneVideo[];
};

export type NudgeScheduledClip = {
  id: string;
  scheduledFor: Date | null;
  status?: string;
  postedAt?: Date | null;
};

export type NudgeFailedVideo = {
  id: string;
  pipelineStage?: string | null;
  pipelineError?: string | null;
  pipelineRetryGeneration?: number | null;
};

export type NudgeDoneVideo = {
  id: string;
  pipelineStage?: string | null;
};

export type DueNudge =
  | {
      id: string;
      kind: "review";
      dedupeKey: string;
      title: string;
      notificationTitle: string;
      body: string;
      href: "/review";
      data: NudgeData;
    }
  | {
      id: string;
      kind: "runway";
      dedupeKey: string;
      title: string;
      notificationTitle: string;
      body: string;
      href: "/upload";
      data: NudgeData;
    }
  | {
      id: string;
      kind: "post";
      dedupeKey: string;
      title: string;
      notificationTitle: string;
      body: string;
      href: string;
      data: NudgeData & {
        clipId: string;
      };
    }
  | {
      id: string;
      kind: "failed";
      dedupeKey: string;
      title: string;
      notificationTitle: string;
      body: string;
      href: "/upload";
      data: NudgeData & {
        videoId: string;
      };
    }
  | {
      id: string;
      kind: "pipeline_done";
      dedupeKey: string;
      title: string;
      notificationTitle: string;
      body: string;
      href: string;
      data: NudgeData & {
        videoId: string;
      };
    };

export type HomeNudge = {
  id: string;
  kind: NudgeKind;
  title: string;
  href: string;
  dismissal: HomeNudgeDismissal;
};

export type HomeNudgeInput = {
  reviewCount: number;
  runway: RunwayState;
  dueClip:
    | {
        clipId: string;
        timeLabel: string | null;
        isDue: boolean;
      }
    | null
    | undefined;
  failedVideos?: readonly NudgeFailedVideo[];
  reviewReminders?: boolean;
  runwayWarnings?: boolean;
  runwayWarningThresholdDays?: number;
  postTimeNudges?: boolean;
};

type NudgeData = {
  url: string;
  kind: NudgeKind;
  dedupeKey: string;
  clipId?: string;
  videoId?: string;
};

export function computeRunway(
  clipCount: number,
  schedule:
    | {
        slotsPerDay: number;
        slotTimes?: readonly string[] | null;
      }
    | null
    | undefined,
): RunwayState {
  if (!schedule) {
    return {
      kind: "needs_schedule",
      clipCount,
      reason: "no_schedule",
    };
  }

  const slotsPerDay = slotCountForSchedule(schedule);
  if (!slotsPerDay || !Number.isFinite(slotsPerDay) || slotsPerDay <= 0) {
    return {
      kind: "needs_schedule",
      clipCount,
      reason: "zero_slots",
    };
  }

  const days = clipCount / slotsPerDay;
  return {
    kind: "ready",
    clipCount,
    slotsPerDay,
    days,
    tone: runwayTone(days),
  };
}

export function runwayTone(days: number): RunwayTone {
  if (days <= 0) {
    return "refill";
  }

  if (days >= 5) {
    return "calm";
  }

  if (days <= 2) {
    return "red";
  }

  return "amber";
}

export function computeDueNudges(
  creator: NudgeCreatorState,
  now: Date,
): DueNudge[] {
  assertValidDate(now, "now");

  const nudges: DueNudge[] = [];
  const dateKey = utcDateKey(now);
  const schedule = creator.schedule;

  // Failed uploads are always-on. Review, runway, and post toggles control
  // optional reminders, but a broken pipeline is required state information.
  for (const video of failedVideosForNudges(creator.failedVideos ?? [])) {
    nudges.push(
      failedNudge(
        video.id,
        video.pipelineError,
        video.pipelineRetryGeneration ?? 0,
      ),
    );
  }

  if (schedule?.reviewReminders !== false && creator.reviewCount > 0) {
    nudges.push(reviewNudge(creator.reviewCount, dateKey));
  }

  const runway = computeRunway(creator.queuedClipCount, schedule);
  const threshold =
    schedule?.runwayThresholdDays ?? RUNWAY_WARNING_THRESHOLD_DAYS;
  if (
    schedule?.runwayWarnings !== false &&
    runway.kind === "ready" &&
    runway.days < threshold
  ) {
    nudges.push(runwayNudge(runway.days, threshold, dateKey));
  }

  if (schedule?.postTimeNudges !== false) {
    for (const clip of dueScheduledClips(creator.scheduledClips, now)) {
      nudges.push(
        postNudge(
          clip.id,
          formatHourMinute(clip.scheduledFor, creator.timezone),
          clip.scheduledFor,
        ),
      );
    }
  }

  for (const video of doneVideosForNudges(creator.doneVideos ?? [])) {
    nudges.push(pipelineDoneNudge(video.id));
  }

  return nudges;
}

export function toHomeNudges(dueNudges: readonly DueNudge[]): HomeNudge[] {
  return dueNudges.slice(0, 3).map(toHomeNudge);
}

export function selectHomeNudges(input: HomeNudgeInput): HomeNudge[] {
  const threshold =
    input.runwayWarningThresholdDays ?? RUNWAY_WARNING_THRESHOLD_DAYS;
  const nudges: DueNudge[] = [];
  const dateKey = "home";

  for (const video of failedVideosForNudges(input.failedVideos ?? [])) {
    nudges.push(
      failedNudge(
        video.id,
        video.pipelineError,
        video.pipelineRetryGeneration ?? 0,
      ),
    );
  }

  if (input.reviewReminders !== false && input.reviewCount > 0) {
    nudges.push(reviewNudge(input.reviewCount, dateKey));
  }

  if (
    input.runwayWarnings !== false &&
    input.runway.kind === "ready" &&
    input.runway.days < threshold
  ) {
    nudges.push(runwayNudge(input.runway.days, threshold, dateKey));
  }

  if (input.postTimeNudges !== false && input.dueClip?.isDue) {
    nudges.push(postNudge(input.dueClip.clipId, input.dueClip.timeLabel, null));
  }

  return toHomeNudges(nudges);
}

export function utcDateKey(date: Date): string {
  assertValidDate(date, "date");
  return date.toISOString().slice(0, 10);
}

export function formatHourMinute(
  date: Date,
  timezone: string | null | undefined,
): string | null {
  return formatCreatorLocalTime(date, timezone);
}

function reviewNudge(reviewCount: number, dedupeKey: string): DueNudge {
  const title = `${reviewCount} ${plural(
    reviewCount,
    "clip",
    "clips",
  )} waiting for review`;

  return {
    id: `review:${reviewCount}`,
    kind: "review",
    dedupeKey,
    title,
    notificationTitle: title,
    body: "Open Review and keep the queue moving.",
    href: "/review",
    data: {
      url: "/review",
      kind: "review",
      dedupeKey,
    },
  };
}

function runwayNudge(
  days: number,
  threshold: number,
  dedupeKey: string,
): DueNudge {
  const title = `Runway under ${threshold} days. Upload something long.`;
  const notificationTitle = `Runway under ${threshold} days`;

  return {
    id: `runway:${Math.round(days * 10)}:${threshold}`,
    kind: "runway",
    dedupeKey,
    title,
    notificationTitle,
    body: "Upload something long before the queue runs dry.",
    href: "/upload",
    data: {
      url: "/upload",
      kind: "runway",
      dedupeKey,
    },
  };
}

function postNudge(
  clipId: string,
  timeLabel: string | null,
  scheduledFor: Date | null,
): DueNudge {
  const href = `/home?post=${encodeURIComponent(clipId)}`;
  const title = timeLabel
    ? `Clip scheduled for ${timeLabel} is ready. Post it now.`
    : "Clip is ready. Post it now.";
  const dedupeKey = scheduledFor
    ? `${clipId}:${scheduledFor.toISOString()}`
    : clipId;

  return {
    id: `post:${clipId}`,
    kind: "post",
    dedupeKey,
    title,
    notificationTitle: timeLabel
      ? `Your ${timeLabel} clip is ready to post`
      : "Your clip is ready to post",
    body: "Open ClipMind, save the clip and caption, then mark it posted.",
    href,
    data: {
      url: href,
      kind: "post",
      dedupeKey,
      clipId,
    },
  };
}

function failedNudge(
  videoId: string,
  pipelineError: string | null | undefined,
  retryGeneration: number,
): DueNudge {
  const title = failedUploadNudgeTitle(pipelineError);
  const notificationTitle = failedUploadTitle(pipelineError);
  const dedupeKey = `${videoId}:${retryGeneration}`;

  return {
    id: `failed:${videoId}`,
    kind: "failed",
    dedupeKey,
    title,
    notificationTitle,
    body: "Tap to retry.",
    href: "/upload",
    data: {
      url: "/upload",
      kind: "failed",
      dedupeKey,
      videoId,
    },
  };
}

function pipelineDoneNudge(videoId: string): DueNudge {
  const href = `/review/${encodeURIComponent(videoId)}`;

  return {
    id: `pipeline_done:${videoId}`,
    kind: "pipeline_done",
    dedupeKey: videoId,
    title: "Clips are ready for review.",
    notificationTitle: "Your clips are ready for review",
    body: "Open Review and pick the strongest ones.",
    href,
    data: {
      url: href,
      kind: "pipeline_done",
      dedupeKey: videoId,
      videoId,
    },
  };
}

function dueScheduledClips(
  clips: readonly NudgeScheduledClip[],
  now: Date,
): Array<NudgeScheduledClip & { scheduledFor: Date }> {
  return clips
    .filter((clip) => clip.status === undefined || clip.status === "scheduled")
    .filter((clip) => !clip.postedAt)
    .filter((clip): clip is NudgeScheduledClip & { scheduledFor: Date } => {
      return Boolean(clip.scheduledFor);
    })
    .filter((clip) => {
      assertValidDate(clip.scheduledFor, "scheduledFor");
      return clip.scheduledFor.getTime() <= now.getTime();
    })
    .sort((left, right) => {
      const scheduledDiff =
        left.scheduledFor.getTime() - right.scheduledFor.getTime();
      if (scheduledDiff !== 0) {
        return scheduledDiff;
      }

      return left.id.localeCompare(right.id);
    });
}

function toHomeNudge(nudge: DueNudge): HomeNudge {
  switch (nudge.kind) {
    case "review":
      return {
        id: nudge.id,
        kind: nudge.kind,
        title: nudge.title,
        href: nudge.href,
        dismissal: "persistent",
      };
    case "runway":
      return {
        id: nudge.id,
        kind: nudge.kind,
        title: nudge.title,
        href: nudge.href,
        dismissal: "persistent",
      };
    case "post":
      return {
        id: nudge.id,
        kind: nudge.kind,
        title: nudge.title,
        href: nudge.href,
        dismissal: "persistent",
      };
    case "failed":
      return {
        id: nudge.id,
        kind: nudge.kind,
        title: nudge.title,
        href: nudge.href,
        dismissal: "session",
      };
    case "pipeline_done":
      return {
        id: nudge.id,
        kind: nudge.kind,
        title: nudge.title,
        href: nudge.href,
        dismissal: "persistent",
      };
  }
}

function failedVideosForNudges(
  videos: readonly NudgeFailedVideo[],
): NudgeFailedVideo[] {
  const seen = new Set<string>();
  const failedVideos: NudgeFailedVideo[] = [];

  for (const video of videos) {
    if (video.pipelineStage !== "failed" || seen.has(video.id)) {
      continue;
    }

    seen.add(video.id);
    failedVideos.push(video);
  }

  return failedVideos;
}

function doneVideosForNudges(
  videos: readonly NudgeDoneVideo[],
): NudgeDoneVideo[] {
  const seen = new Set<string>();
  const doneVideos: NudgeDoneVideo[] = [];

  for (const video of videos) {
    if (video.pipelineStage !== "done" || seen.has(video.id)) {
      continue;
    }

    seen.add(video.id);
    doneVideos.push(video);
  }

  return doneVideos;
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid Date.`);
  }
}
