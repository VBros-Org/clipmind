-- Add deterministic scheduling state.
ALTER TABLE "Schedule" ADD COLUMN "slotsPerDay" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Schedule" ADD COLUMN "lastScheduledAt" TIMESTAMP(3);

ALTER TABLE "Clip" ADD COLUMN "scheduledFor" TIMESTAMP(3);
ALTER TABLE "Clip" ADD COLUMN "postedAt" TIMESTAMP(3);
