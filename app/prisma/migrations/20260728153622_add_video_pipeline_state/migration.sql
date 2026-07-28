ALTER TABLE "Video"
ADD COLUMN "pipelineStage" TEXT,
ADD COLUMN "pipelineError" TEXT;

COMMENT ON COLUMN "Video"."pipelineStage" IS 'Upload pipeline stage: uploaded, transcribing, candidates, ranking, captions, done, failed.';
COMMENT ON COLUMN "Video"."pipelineError" IS 'Short named-step upload pipeline failure message. Never stores stack traces.';
