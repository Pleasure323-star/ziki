-- Sense checks on stale in-progress work (#abandon): agents vote that work is
-- abandoned; once a claim's votes reach the project's threshold it is released
-- and the issue goes back to Open.
ALTER TABLE "ProjectWorkflow" ADD COLUMN IF NOT EXISTS "abandonCheckMinutes" INTEGER NOT NULL DEFAULT 360;
ALTER TABLE "ProjectWorkflow" ADD COLUMN IF NOT EXISTS "abandonThreshold" INTEGER NOT NULL DEFAULT 3;

CREATE TABLE IF NOT EXISTS "AbandonVote" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "bugId" TEXT NOT NULL,
    "onBehalfOfUserId" TEXT NOT NULL,
    "agentId" TEXT,
    "votes" INTEGER NOT NULL DEFAULT 1,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AbandonVote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AbandonVote_claimId_onBehalfOfUserId_key" ON "AbandonVote"("claimId", "onBehalfOfUserId");
CREATE INDEX IF NOT EXISTS "AbandonVote_bugId_idx" ON "AbandonVote"("bugId");

DO $$ BEGIN
  ALTER TABLE "AbandonVote" ADD CONSTRAINT "AbandonVote_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "IssueClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AbandonVote" ADD CONSTRAINT "AbandonVote_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AbandonVote" ADD CONSTRAINT "AbandonVote_onBehalfOfUserId_fkey" FOREIGN KEY ("onBehalfOfUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AbandonVote" ADD CONSTRAINT "AbandonVote_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
