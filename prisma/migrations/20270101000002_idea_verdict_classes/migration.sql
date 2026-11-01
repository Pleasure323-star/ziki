-- Two idea verdicts per person (#idea-verdict-classes): one given with a
-- manager or merger agent ("manager", up to managerVoteWeight votes) and one
-- with a worker agent or in the web app ("working", 1 vote). Existing verdicts
-- take the class of the agent that gave them. Safe to run again.
ALTER TABLE "IdeaVerdict" ADD COLUMN IF NOT EXISTS "weightClass" TEXT NOT NULL DEFAULT 'working';
UPDATE "IdeaVerdict" v
SET "weightClass" = 'manager'
FROM "Agent" a
WHERE a."id" = v."agentId" AND a."level" IN ('manager', 'merger') AND v."weightClass" <> 'manager';

DROP INDEX IF EXISTS "IdeaVerdict_ideaId_onBehalfOfUserId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "IdeaVerdict_ideaId_onBehalfOfUserId_weightClass_key"
  ON "IdeaVerdict"("ideaId", "onBehalfOfUserId", "weightClass");
