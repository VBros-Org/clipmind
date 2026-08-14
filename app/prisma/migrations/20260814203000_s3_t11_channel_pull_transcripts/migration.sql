-- Persist channel-pull transcripts as durable creator evidence.
-- New table only: no existing rows need backfill, and no existing columns are rewritten.
CREATE TABLE "ChannelPullTranscript" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "videoUrl" TEXT NOT NULL,
    "title" TEXT,
    "durationS" INTEGER,
    "transcript" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelPullTranscript_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChannelPullTranscript_creatorId_videoId_key" ON "ChannelPullTranscript"("creatorId", "videoId");
CREATE INDEX "ChannelPullTranscript_creatorId_createdAt_idx" ON "ChannelPullTranscript"("creatorId", "createdAt");

ALTER TABLE "ChannelPullTranscript"
ADD CONSTRAINT "ChannelPullTranscript_creatorId_fkey"
FOREIGN KEY ("creatorId") REFERENCES "Creator"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
