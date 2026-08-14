export type MediaPreparationProgress = {
  loadedBytes: number;
  totalBytes: number | null;
};

export function formatMediaPreparationProgress(
  progress: MediaPreparationProgress,
): string {
  if (progress.totalBytes && progress.totalBytes > 0) {
    const percent = Math.max(
      0,
      Math.min(100, Math.round((progress.loadedBytes / progress.totalBytes) * 100)),
    );
    return `Preparing video: ${percent}%`;
  }

  if (progress.loadedBytes > 0) {
    return `Preparing video: ${formatBytes(progress.loadedBytes)}`;
  }

  return "Preparing video.";
}

export function saveDisabledReason({
  canPost,
  canShareVideo,
  hasPreparedFile,
  isPreparingVideo,
  progress,
}: {
  canPost: boolean;
  canShareVideo: boolean;
  hasPreparedFile: boolean;
  isPreparingVideo: boolean;
  progress: MediaPreparationProgress;
}): string | null {
  if (!canPost) {
    return "Rendered MP4 is not ready yet.";
  }

  if (isPreparingVideo || !hasPreparedFile) {
    return formatMediaPreparationProgress(progress);
  }

  if (!canShareVideo) {
    return "This browser cannot save directly. Use Download.";
  }

  return null;
}

function formatBytes(bytes: number): string {
  const safeBytes = Math.max(0, bytes);
  if (safeBytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(safeBytes / 1024))} KB`;
  }

  return `${(safeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
