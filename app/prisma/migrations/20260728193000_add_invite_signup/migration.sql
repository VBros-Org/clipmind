ALTER TABLE "Creator"
ADD COLUMN "displayName" TEXT,
ADD COLUMN "mindStage" TEXT,
ADD COLUMN "mindError" TEXT;

COMMENT ON COLUMN "Creator"."mindStage" IS 'Creator Mind onboarding stage: pending, learning_voice, waking_mind, teaching_taste, ready, failed.';
COMMENT ON COLUMN "Creator"."mindError" IS 'Short named-step Mind onboarding failure message. Never stores stack traces.';

CREATE TABLE "InviteCode" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "note" TEXT,
  "usedByCreatorId" TEXT,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InviteCode_code_key" ON "InviteCode"("code");
CREATE UNIQUE INDEX "InviteCode_usedByCreatorId_key" ON "InviteCode"("usedByCreatorId");

ALTER TABLE "InviteCode"
ADD CONSTRAINT "InviteCode_usedByCreatorId_fkey"
FOREIGN KEY ("usedByCreatorId") REFERENCES "Creator"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
