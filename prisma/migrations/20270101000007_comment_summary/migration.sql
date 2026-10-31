-- A comment's summary, shown above its body (#730). Older comments keep none. Safe to run again.
ALTER TABLE "Comment" ADD COLUMN IF NOT EXISTS "summary" TEXT;
