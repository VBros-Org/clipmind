-- Add ingest idempotency and candidate metadata fields.
ALTER TABLE "Video" ADD COLUMN "contentKey" TEXT;

ALTER TABLE "Clip" ADD COLUMN "transcript" TEXT;
ALTER TABLE "Clip" ADD COLUMN "reasons" JSONB;

CREATE UNIQUE INDEX "Video_contentKey_key" ON "Video"("contentKey");
