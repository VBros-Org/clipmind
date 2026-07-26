-- CreateEnum
CREATE TYPE "ClipStatus" AS ENUM ('candidate', 'accepted', 'rejected', 'scheduled', 'posted');

-- CreateTable
CREATE TABLE "Creator" (
    "id" TEXT NOT NULL,
    "channelUrl" TEXT,
    "mindId" TEXT,
    "captionStyle" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Creator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Clip" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "trimStartMs" INTEGER,
    "trimEndMs" INTEGER,
    "renderedUrl" TEXT,
    "postCopy" TEXT,
    "status" "ClipStatus" NOT NULL DEFAULT 'candidate',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Clip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "slots" JSONB NOT NULL,
    "rotation" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningEvent" (
    "id" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearningEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Schedule_creatorId_key" ON "Schedule"("creatorId");

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Clip" ADD CONSTRAINT "Clip_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Clip" ADD CONSTRAINT "Clip_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
