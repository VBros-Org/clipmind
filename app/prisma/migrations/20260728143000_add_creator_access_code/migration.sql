ALTER TABLE "Creator" ADD COLUMN "accessCode" TEXT;

CREATE UNIQUE INDEX "Creator_accessCode_key" ON "Creator"("accessCode");
