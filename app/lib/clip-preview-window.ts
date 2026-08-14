export type ClipPreviewWindow = {
  startMs: number;
  endMs: number;
};

export const PREVIEW_SEEK_TOLERANCE_SECONDS = 0.2;

export function clipWindowStartSeconds(window: ClipPreviewWindow): number {
  return Math.max(0, window.startMs / 1000);
}

export function clipWindowEndSeconds(window: ClipPreviewWindow): number {
  return Math.max(clipWindowStartSeconds(window), window.endMs / 1000);
}

export function clipWindowDurationSeconds(window: ClipPreviewWindow): number {
  return Math.max(0, clipWindowEndSeconds(window) - clipWindowStartSeconds(window));
}

export function shouldSeekPreviewToStart(
  currentTimeSeconds: number,
  window: ClipPreviewWindow,
  options: {
    firstLoad?: boolean;
    toleranceSeconds?: number;
  } = {},
): boolean {
  if (options.firstLoad) {
    return true;
  }

  const toleranceSeconds =
    options.toleranceSeconds ?? PREVIEW_SEEK_TOLERANCE_SECONDS;
  return isOutsideClipWindow(currentTimeSeconds, window, toleranceSeconds);
}

export function isOutsideClipWindow(
  currentTimeSeconds: number,
  window: ClipPreviewWindow,
  toleranceSeconds = PREVIEW_SEEK_TOLERANCE_SECONDS,
): boolean {
  if (!Number.isFinite(currentTimeSeconds)) {
    return true;
  }

  const startSeconds = clipWindowStartSeconds(window);
  const endSeconds = clipWindowEndSeconds(window);
  return (
    currentTimeSeconds < startSeconds - toleranceSeconds ||
    currentTimeSeconds >= endSeconds
  );
}

export function clampToClipWindowSeconds(
  currentTimeSeconds: number,
  window: ClipPreviewWindow,
): number {
  const startSeconds = clipWindowStartSeconds(window);
  const endSeconds = clipWindowEndSeconds(window);

  if (!Number.isFinite(currentTimeSeconds) || endSeconds <= startSeconds) {
    return startSeconds;
  }

  return Math.min(endSeconds, Math.max(startSeconds, currentTimeSeconds));
}

export function clipWindowOffsetSeconds(
  currentTimeSeconds: number,
  window: ClipPreviewWindow,
): number {
  return clampToClipWindowSeconds(currentTimeSeconds, window) -
    clipWindowStartSeconds(window);
}

export function clipWindowTimeFromOffsetSeconds(
  offsetSeconds: number,
  window: ClipPreviewWindow,
): number {
  const durationSeconds = clipWindowDurationSeconds(window);
  const clampedOffset = Math.min(
    durationSeconds,
    Math.max(0, Number.isFinite(offsetSeconds) ? offsetSeconds : 0),
  );

  return clipWindowStartSeconds(window) + clampedOffset;
}
