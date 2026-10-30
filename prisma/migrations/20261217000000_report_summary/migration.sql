-- A report's short summary: up to three plain lines a person reads at a
-- glance instead of the long description. Agents must send one when they
-- file a report; it rides along when the idea becomes an issue. Older
-- reports have none.
ALTER TABLE "Idea" ADD COLUMN IF NOT EXISTS "summary" TEXT;
ALTER TABLE "Bug" ADD COLUMN IF NOT EXISTS "summary" TEXT;
