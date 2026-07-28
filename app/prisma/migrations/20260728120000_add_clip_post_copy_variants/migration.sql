ALTER TABLE "Clip" ADD COLUMN "postCopyVariants" JSONB;

COMMENT ON COLUMN "Clip"."postCopy" IS 'Legacy default post-copy. Mirrors postCopyVariants.tiktok.';
COMMENT ON COLUMN "Clip"."postCopyVariants" IS 'Post-copy variants keyed by platform: youtube, tiktok, instagram.';
