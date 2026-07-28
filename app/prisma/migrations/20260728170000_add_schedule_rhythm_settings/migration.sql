-- Add Rhythm schedule settings.
ALTER TABLE "Schedule" ADD COLUMN "anchorHour" INTEGER NOT NULL DEFAULT 9;
ALTER TABLE "Schedule" ADD COLUMN "reviewReminders" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Schedule" ADD COLUMN "runwayWarnings" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Schedule" ADD COLUMN "runwayThresholdDays" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "Schedule" ADD COLUMN "postTimeNudges" BOOLEAN NOT NULL DEFAULT true;
