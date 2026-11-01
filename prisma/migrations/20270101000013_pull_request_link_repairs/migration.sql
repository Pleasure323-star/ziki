-- Repaired pull request links (#pr-link-repair): the old link kept, with the verified canonical PR or commit.
CREATE TABLE IF NOT EXISTS "PullRequestLinkRepair" (
    "id" TEXT NOT NULL,
    "bugId" TEXT NOT NULL,
    "originalUrl" TEXT NOT NULL,
    "canonicalUrl" TEXT,
    "inaccessible" BOOLEAN NOT NULL DEFAULT false,
    "evidence" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "onBehalfOfUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PullRequestLinkRepair_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PullRequestLinkRepair_bugId_originalUrl_key" ON "PullRequestLinkRepair"("bugId", "originalUrl");
ALTER TABLE "PullRequestLinkRepair" DROP CONSTRAINT IF EXISTS "PullRequestLinkRepair_bugId_fkey";
ALTER TABLE "PullRequestLinkRepair" ADD CONSTRAINT "PullRequestLinkRepair_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;
