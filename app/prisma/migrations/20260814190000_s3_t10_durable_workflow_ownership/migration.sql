ALTER TABLE "Video"
  ADD COLUMN "pipelineRunId" TEXT,
  ADD COLUMN "pipelineLeaseHeartbeatAt" TIMESTAMP(3),
  ADD COLUMN "pipelineStageAttempts" JSONB;

ALTER TABLE "Creator"
  ADD COLUMN "mindRunId" TEXT,
  ADD COLUMN "mindLeaseHeartbeatAt" TIMESTAMP(3),
  ADD COLUMN "mindStageAttempts" JSONB,
  ADD COLUMN "channelPullRunId" TEXT,
  ADD COLUMN "channelPullLeaseHeartbeatAt" TIMESTAMP(3),
  ADD COLUMN "channelPullStageAttempts" JSONB;

COMMENT ON COLUMN "Video"."pipelineRunId" IS 'Durable owner id for the active or last upload pipeline run.';
COMMENT ON COLUMN "Video"."pipelineLeaseHeartbeatAt" IS 'Last upload pipeline owner heartbeat. Active runs are retryable after 10 minutes without one.';
COMMENT ON COLUMN "Video"."pipelineStageAttempts" IS 'JSON object keyed by upload pipeline stage with durable attempt counts.';

COMMENT ON COLUMN "Creator"."mindRunId" IS 'Durable owner id for the active or last first-video Mind onboarding run.';
COMMENT ON COLUMN "Creator"."mindLeaseHeartbeatAt" IS 'Last first-video Mind onboarding owner heartbeat. Active runs are retryable after 10 minutes without one.';
COMMENT ON COLUMN "Creator"."mindStageAttempts" IS 'JSON object keyed by first-video Mind onboarding stage with durable attempt counts.';
COMMENT ON COLUMN "Creator"."channelPullRunId" IS 'Durable owner id for the active or last channel pull run.';
COMMENT ON COLUMN "Creator"."channelPullLeaseHeartbeatAt" IS 'Last channel pull owner heartbeat. Active runs are retryable after 10 minutes without one.';
COMMENT ON COLUMN "Creator"."channelPullStageAttempts" IS 'JSON object keyed by channel pull stage with durable attempt counts.';
