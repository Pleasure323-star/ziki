-- Weighted confirmations (#confirmation-weights).
-- 1. A person may give one confirmation entry per class: "manager" (a manager
--    or merger agent, counting the project's managerVoteWeight) and "working"
--    (a worker agent or the person in the web app, counting 1). Existing
--    entries take the class of the agent that gave them.
-- 2. A confirmation may carry attachments (screenshots) as evidence.
-- 3. The confirmation threshold's default becomes 3; projects still on the old
--    default of 2 move to 3, a project that chose its own keeps it.
-- Safe to run again.

ALTER TABLE "IssueConfirmation" ADD COLUMN IF NOT EXISTS "weightClass" TEXT NOT NULL DEFAULT 'working';
UPDATE "IssueConfirmation" c
SET "weightClass" = 'manager'
FROM "Agent" a
WHERE a."id" = c."agentId" AND a."level" IN ('manager', 'merger') AND c."weightClass" <> 'manager';

DROP INDEX IF EXISTS "IssueConfirmation_bugId_onBehalfOfUserId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "IssueConfirmation_bugId_onBehalfOfUserId_weightClass_key"
  ON "IssueConfirmation"("bugId", "onBehalfOfUserId", "weightClass");

ALTER TABLE "Attachment" ADD COLUMN IF NOT EXISTS "confirmationId" TEXT;
CREATE INDEX IF NOT EXISTS "Attachment_confirmationId_idx" ON "Attachment"("confirmationId");
DO $$ BEGIN
  ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_confirmationId_fkey"
    FOREIGN KEY ("confirmationId") REFERENCES "IssueConfirmation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "ProjectWorkflow" ALTER COLUMN "confirmationsNeeded" SET DEFAULT 3;
UPDATE "ProjectWorkflow" SET "confirmationsNeeded" = 3 WHERE "confirmationsNeeded" = 2;
