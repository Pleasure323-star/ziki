-- Idea rejected: the idea status `closed`, which nothing ever set, becomes
-- `rejected`, set by a manager agent on an idea with more than 5 votes and
-- fewer than 3 good ones (lib/idea-rejection.ts). One status for it, not two.
-- Safe to run again: the rename only happens while `closed` still exists.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'IdeaStatus' AND e.enumlabel = 'closed'
  ) THEN
    ALTER TYPE "IdeaStatus" RENAME VALUE 'closed' TO 'rejected';
  END IF;
END $$;

ALTER TABLE "Idea" ADD COLUMN IF NOT EXISTS "rejectedAt" TIMESTAMP(3);
ALTER TABLE "Idea" ADD COLUMN IF NOT EXISTS "rejectedByAgentId" TEXT;
