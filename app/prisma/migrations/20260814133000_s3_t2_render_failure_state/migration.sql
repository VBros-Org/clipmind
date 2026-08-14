ALTER TABLE "Clip"
  ADD COLUMN "renderFailedAt" TIMESTAMP(3),
  ADD COLUMN "renderError" VARCHAR(500);

COMMENT ON COLUMN "Clip"."renderFailedAt" IS 'Last render failure timestamp for retryable review state.';
COMMENT ON COLUMN "Clip"."renderError" IS 'Capped render failure detail for the creator review UI.';
