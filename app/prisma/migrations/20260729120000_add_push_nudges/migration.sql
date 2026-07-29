ALTER TABLE "Schedule" ADD COLUMN "pushNudges" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMP(3),

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NudgeLog" (
    "creatorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NudgeLog_pkey" PRIMARY KEY ("creatorId","kind","dedupeKey")
);

CREATE UNIQUE INDEX "PushSubscription_token_key" ON "PushSubscription"("token");
CREATE INDEX "PushSubscription_creatorId_disabledAt_idx" ON "PushSubscription"("creatorId", "disabledAt");
CREATE INDEX "NudgeLog_sentAt_idx" ON "NudgeLog"("sentAt");

ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NudgeLog" ADD CONSTRAINT "NudgeLog_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
