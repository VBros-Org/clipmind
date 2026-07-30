export const CHANNEL_PULL_STAGES = [
  "listing",
  "transcribing_1",
  "transcribing_2",
  "transcribing_3",
  "distilling",
  "seeding",
  "done",
  "failed",
] as const;

export type ChannelPullStage = (typeof CHANNEL_PULL_STAGES)[number];
export type ActiveChannelPullStage = Exclude<
  ChannelPullStage,
  "done" | "failed"
>;

export const YT_BLOCKED_CHANNEL_PULL_MESSAGE =
  "YouTube would not let our server fetch this right now. Paste captions or upload a video instead.";

const FRIENDLY_FAILED_MESSAGE =
  "Recent video pull failed. Paste captions or upload a video instead.";

const STAGE_LINES: Record<ActiveChannelPullStage | "done", string> = {
  listing: "Looking for recent YouTube uploads.",
  transcribing_1: "Transcribing recent video 1.",
  transcribing_2: "Transcribing recent video 2.",
  transcribing_3: "Transcribing recent video 3.",
  distilling: "Updating your voice profile.",
  seeding: "Teaching your Mind.",
  done: "Recent videos added to your voice.",
};

export type ChannelPullStatusView = {
  stage: ChannelPullStage | null;
  error: string | null;
  errorCode: string | null;
};

export function isChannelPullStage(
  value: string | null | undefined,
): value is ChannelPullStage {
  return CHANNEL_PULL_STAGES.includes(value as ChannelPullStage);
}

export function isActiveChannelPullStage(
  value: string | null | undefined,
): value is ActiveChannelPullStage {
  return (
    isChannelPullStage(value) &&
    value !== "done" &&
    value !== "failed"
  );
}

export function friendlyChannelPullError(
  error: string | null | undefined,
): string | null {
  if (!error) {
    return null;
  }
  if (channelPullErrorCode(error) === "yt_blocked") {
    return YT_BLOCKED_CHANNEL_PULL_MESSAGE;
  }

  return FRIENDLY_FAILED_MESSAGE;
}

export function channelPullProgressLine(
  status: ChannelPullStatusView,
): string | null {
  if (!status.stage) {
    return null;
  }
  if (status.stage === "failed") {
    return status.error ?? FRIENDLY_FAILED_MESSAGE;
  }
  if (status.stage === "done") {
    return STAGE_LINES.done;
  }

  return STAGE_LINES[status.stage];
}

export function channelPullErrorCode(
  error: string | null | undefined,
): string | null {
  if (!error) {
    return null;
  }
  return error.includes("yt_blocked") ? "yt_blocked" : null;
}
