-- CreateTable
CREATE TABLE "UploadIntent" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "videoId" TEXT,
    "sourceKey" TEXT NOT NULL,
    "uploadId" TEXT,
    "fileName" TEXT,
    "contentType" TEXT NOT NULL,
    "declaredSizeBytes" BIGINT NOT NULL,
    "partSizeBytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "failureReason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "abortedAt" TIMESTAMP(3),

    CONSTRAINT "UploadIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UploadIntent_videoId_key" ON "UploadIntent"("videoId");

-- CreateIndex
CREATE UNIQUE INDEX "UploadIntent_sourceKey_key" ON "UploadIntent"("sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "UploadIntent_sourceKey_uploadId_key" ON "UploadIntent"("sourceKey", "uploadId");

-- CreateIndex
CREATE INDEX "UploadIntent_creatorId_status_lastActivityAt_idx" ON "UploadIntent"("creatorId", "status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "UploadIntent_status_lastActivityAt_idx" ON "UploadIntent"("status", "lastActivityAt");

-- AddForeignKey
ALTER TABLE "UploadIntent" ADD CONSTRAINT "UploadIntent_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMENT ON TABLE "UploadIntent" IS 'Server-owned direct-to-R2 multipart upload session state. Video rows are created only after completion reconciliation.';
COMMENT ON COLUMN "UploadIntent"."declaredSizeBytes" IS 'Browser-declared file size for reconciliation against authoritative R2 part sizes.';
