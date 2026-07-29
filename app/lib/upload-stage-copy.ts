export type UploadWorkflowStage =
  | "learning_voice"
  | "waking_mind"
  | "teaching_taste"
  | "uploaded"
  | "transcribing"
  | "candidates"
  | "ranking"
  | "captions"
  | "done"
  | "failed";

export function isActiveUploadStage(
  stage: string | null | undefined,
): boolean {
  return Boolean(stage && stage !== "done");
}

export function uploadStageLabel(stage: string | null | undefined): string {
  switch (stage) {
    case "uploaded":
      return "uploaded";
    case "learning_voice":
      return "learning voice";
    case "waking_mind":
      return "waking Mind";
    case "teaching_taste":
      return "teaching taste";
    case "transcribing":
      return "transcribing";
    case "candidates":
      return "finding moments";
    case "ranking":
      return "ranking by your Mind";
    case "captions":
      return "captions";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return stage?.trim() || "processing";
  }
}

export function uploadStageTitle(stage: string | null | undefined): string {
  switch (stage) {
    case "learning_voice":
      return "Learning your voice";
    case "waking_mind":
      return "Waking your Mind";
    case "teaching_taste":
      return "Teaching it your taste";
    case "uploaded":
      return "Uploaded";
    case "transcribing":
      return "Transcribing";
    case "candidates":
      return "Finding moments";
    case "ranking":
      return "Ranking by your Mind";
    case "captions":
      return "Writing captions";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    default:
      return titleCase(stage?.trim() || "Processing");
  }
}

export function failedStageFromPipelineError(
  error: string | null | undefined,
): UploadWorkflowStage | null {
  const prefix = error?.split(":", 1)[0]?.trim() ?? null;
  return isKnownUploadStage(prefix) && prefix !== "done" && prefix !== "failed"
    ? prefix
    : null;
}

export function failedUploadStageLabel(
  error: string | null | undefined,
): string {
  return uploadStageLabel(failedStageFromPipelineError(error) ?? "transcribing");
}

export function failedUploadTitle(error: string | null | undefined): string {
  return `Upload failed at ${failedUploadStageLabel(error)}.`;
}

export function failedUploadNudgeTitle(
  error: string | null | undefined,
): string {
  return `${failedUploadTitle(error)} Tap to retry.`;
}

function isKnownUploadStage(
  value: string | null | undefined,
): value is UploadWorkflowStage {
  return (
    value === "learning_voice" ||
    value === "waking_mind" ||
    value === "teaching_taste" ||
    value === "uploaded" ||
    value === "transcribing" ||
    value === "candidates" ||
    value === "ranking" ||
    value === "captions" ||
    value === "done" ||
    value === "failed"
  );
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (first) => first.toUpperCase());
}
