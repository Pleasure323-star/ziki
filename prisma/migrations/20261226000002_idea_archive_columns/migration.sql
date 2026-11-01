-- Archived ideas (#idea-archive): why a manager agent archived an idea
-- ("already_implemented", "duplicate" or "wrong_project"), the evidence it
-- gave, what a duplicate duplicates ("idea:12" or "issue:34"), when, and which
-- agent. Safe to run again.
ALTER TABLE "Idea" ADD COLUMN IF NOT EXISTS "archiveReason" TEXT;
ALTER TABLE "Idea" ADD COLUMN IF NOT EXISTS "archiveEvidence" TEXT;
ALTER TABLE "Idea" ADD COLUMN IF NOT EXISTS "archiveDuplicateOf" TEXT;
ALTER TABLE "Idea" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "Idea" ADD COLUMN IF NOT EXISTS "archivedByAgentId" TEXT;
