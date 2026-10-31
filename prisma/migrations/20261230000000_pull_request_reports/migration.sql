-- Pull request reports (#pr-reports). Ziki never calls GitHub: an agent independent
-- of the issue checks the linked pull request on GitHub and reports what it saw.
-- The latest report for the issue's current pull request is the PR's state, and
-- every rule reads that one. New table and enum only; no existing row changes.
DO $$ BEGIN
    CREATE TYPE "PullRequestState" AS ENUM ('open', 'closed', 'merged', 'not_found');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "PullRequestReport" (
    "id" TEXT NOT NULL,
    "bugId" TEXT NOT NULL,
    "pullRequestUrl" TEXT NOT NULL,
    "state" "PullRequestState" NOT NULL,
    "mergedInto" TEXT,
    "inDefaultBranch" BOOLEAN,
    "headSha" TEXT,
    "mergeCommitSha" TEXT,
    "checks" TEXT,
    "mergeable" BOOLEAN,
    "note" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "onBehalfOfUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PullRequestReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PullRequestReport_bugId_createdAt_idx" ON "PullRequestReport"("bugId", "createdAt");
CREATE INDEX IF NOT EXISTS "PullRequestReport_agentId_idx" ON "PullRequestReport"("agentId");

DO $$ BEGIN
    ALTER TABLE "PullRequestReport" ADD CONSTRAINT "PullRequestReport_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "PullRequestReport" ADD CONSTRAINT "PullRequestReport_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "PullRequestReport" ADD CONSTRAINT "PullRequestReport_onBehalfOfUserId_fkey" FOREIGN KEY ("onBehalfOfUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
