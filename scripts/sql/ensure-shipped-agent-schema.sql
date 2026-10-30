-- Additive repair for migrations that signed-in pages now query:
-- 20261022000000_redesign_mockups_and_choice (preview columns),
-- 20261022150000_default_project_agent_key,
-- 20261022160000_issue_bids.
-- migrate deploy can stop on an earlier failure. No drops.

ALTER TABLE "RedesignProposal" ADD COLUMN IF NOT EXISTS "previewUrl" TEXT;
ALTER TABLE "Attachment" ADD COLUMN IF NOT EXISTS "redesignProposalId" TEXT;
CREATE INDEX IF NOT EXISTS "Attachment_redesignProposalId_idx" ON "Attachment"("redesignProposalId");

DO $$ BEGIN
  ALTER TABLE "Attachment"
    ADD CONSTRAINT "Attachment_redesignProposalId_fkey"
    FOREIGN KEY ("redesignProposalId") REFERENCES "RedesignProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "defaultProjectId" TEXT;
ALTER TABLE "AgentApiKey" ADD COLUMN IF NOT EXISTS "sealedKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Agent_ownerUserId_defaultProjectId_key" ON "Agent"("ownerUserId", "defaultProjectId");

DO $$ BEGIN
  ALTER TABLE "Agent"
    ADD CONSTRAINT "Agent_defaultProjectId_fkey"
    FOREIGN KEY ("defaultProjectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "IssueBid" (
    "id" TEXT NOT NULL,
    "bugId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "beneficiaryUserId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),
    "awardedAt" TIMESTAMP(3),
    "claimId" TEXT,
    CONSTRAINT "IssueBid_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IssueBid_bugId_agentId_key" ON "IssueBid"("bugId", "agentId");
CREATE UNIQUE INDEX IF NOT EXISTS "IssueBid_claimId_key" ON "IssueBid"("claimId");
CREATE INDEX IF NOT EXISTS "IssueBid_bugId_createdAt_idx" ON "IssueBid"("bugId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "IssueBid" ADD CONSTRAINT "IssueBid_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "IssueBid" ADD CONSTRAINT "IssueBid_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "IssueBid" ADD CONSTRAINT "IssueBid_beneficiaryUserId_fkey" FOREIGN KEY ("beneficiaryUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "IssueBid" ADD CONSTRAINT "IssueBid_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "IssueClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE "AgentLevel" ADD VALUE IF NOT EXISTS 'admin_merger';

