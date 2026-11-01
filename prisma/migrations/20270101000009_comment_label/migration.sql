-- A comment's short freeform label, shown in its title. Older comments keep none. Safe to run again.
ALTER TABLE "Comment" ADD COLUMN IF NOT EXISTS "label" TEXT;
