import {
  failedUploadTitle,
  isActiveUploadStage,
  uploadStageTitle,
} from "./upload-stage-copy";

export type HomeUploadVideo = {
  id: string;
  label: string;
  pipelineStage: string | null;
  pipelineError: string | null;
};

export type HomeUploadCard = {
  id: string;
  label: string;
  variant: "processing" | "failed";
  title: string;
  body: string;
  href: "/upload";
};

export function selectHomeUploadCards(
  videos: readonly HomeUploadVideo[],
): HomeUploadCard[] {
  return videos
    .filter((video) => isActiveUploadStage(video.pipelineStage))
    .map((video) => {
      if (video.pipelineStage === "failed") {
        return {
          id: video.id,
          label: video.label,
          variant: "failed",
          title: failedUploadTitle(video.pipelineError),
          body: "Tap to retry.",
          href: "/upload",
        };
      }

      return {
        id: video.id,
        label: video.label,
        variant: "processing",
        title: uploadStageTitle(video.pipelineStage),
        body: "usually a few minutes",
        href: "/upload",
      };
    });
}
