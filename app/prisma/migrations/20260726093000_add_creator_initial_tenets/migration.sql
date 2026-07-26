-- Add initial Tenets distilled during creator onboarding.
ALTER TABLE "Creator" ADD COLUMN "initialTenets" JSONB;
