-- Close suggestions (#close-superseded): agents suggest closing an issue for a
-- reason ("superseded" for now), each with a comment. Once the votes reach the
-- project's closeThreshold, a manager agent closes the issue with that reason.
ALTER TABLE "ProjectWorkflow" ADD COLUMN IF NOT EXISTS "closeThreshold" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "Bug" ADD COLUMN IF NOT EXISTS "closeReason" TEXT;

CREATE TABLE IF NOT EXISTS "CloseSuggestion" (
    "id" TEXT NOT NULL,
    "bugId" TEXT NOT NULL,
    "onBehalfOfUserId" TEXT NOT NULL,
    "agentId" TEXT,
    "reason" TEXT NOT NULL,
    "votes" INTEGER NOT NULL DEFAULT 1,
    "summary" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CloseSuggestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CloseSuggestion_bugId_onBehalfOfUserId_key" ON "CloseSuggestion"("bugId", "onBehalfOfUserId");
CREATE INDEX IF NOT EXISTS "CloseSuggestion_bugId_idx" ON "CloseSuggestion"("bugId");

DO $$ BEGIN
  ALTER TABLE "CloseSuggestion" ADD CONSTRAINT "CloseSuggestion_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CloseSuggestion" ADD CONSTRAINT "CloseSuggestion_onBehalfOfUserId_fkey" FOREIGN KEY ("onBehalfOfUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CloseSuggestion" ADD CONSTRAINT "CloseSuggestion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
