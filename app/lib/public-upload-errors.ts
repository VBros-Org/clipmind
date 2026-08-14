import { failedPipelineStage } from "./pipeline";
import {
  failedMindOnboardingStage,
  isMindOnboardingStage,
} from "./video-onboarding";

const PUBLIC_UPLOAD_ERROR_LABELS: Record<string, string> = {
  learning_voice: "Voice learning failed.",
  waking_mind: "Mind setup failed.",
  teaching_taste: "Taste teaching failed.",
  uploaded: "Upload setup failed.",
  transcribing: "Transcription failed.",
  candidates: "Moment detection failed.",
  ranking: "Mind ranking failed.",
  captions: "Caption writing failed.",
};

export function publicUploadWorkflowErrorMessage(
  error: string | null | undefined,
  fallbackStage?: string | null,
): string | null {
  if (!error && !fallbackStage) {
    return null;
  }

  const stage = knownStage(fallbackStage) ?? knownStage(stagePrefix(error));
  if (stage) {
    return publicStageErrorMessage(stage);
  }

  return publicStageErrorMessage(failedPipelineStage(error));
}

export function publicPipelineErrorMessage(
  error: string | null | undefined,
): string | null {
  if (!error) {
    return null;
  }

  return publicStageErrorMessage(failedPipelineStage(error));
}

export function publicMindOnboardingErrorMessage(
  error: string | null | undefined,
): string | null {
  if (!error) {
    return null;
  }

  return publicStageErrorMessage(failedMindOnboardingStage(error));
}

function publicStageErrorMessage(stage: string): string {
  return `${stage}: ${
    PUBLIC_UPLOAD_ERROR_LABELS[stage] ?? "Upload processing failed."
  }`;
}

function knownStage(stage: string | null | undefined): string | null {
  if (!stage || stage === "done" || stage === "failed") {
    return null;
  }

  if (
    stage === "uploaded" ||
    stage === "transcribing" ||
    stage === "candidates" ||
    stage === "ranking" ||
    stage === "captions" ||
    isMindOnboardingStage(stage)
  ) {
    return stage;
  }

  return null;
}

function stagePrefix(error: string | null | undefined): string | null {
  return error?.split(":", 1)[0]?.trim() || null;
}
