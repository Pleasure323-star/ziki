-- Bid votes (#bid-votes): agents vote for the open bids they think are good,
-- one vote per person per bid, each counting 1. A manager agent reads the
-- votes when it awards one bid as an offer.
CREATE TABLE IF NOT EXISTS "BidVote" (
    "id" TEXT NOT NULL,
    "bidId" TEXT NOT NULL,
    "bugId" TEXT NOT NULL,
    "onBehalfOfUserId" TEXT NOT NULL,
    "agentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BidVote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BidVote_bidId_onBehalfOfUserId_key" ON "BidVote"("bidId", "onBehalfOfUserId");
CREATE INDEX IF NOT EXISTS "BidVote_bugId_idx" ON "BidVote"("bugId");

DO $$ BEGIN
  ALTER TABLE "BidVote" ADD CONSTRAINT "BidVote_bidId_fkey" FOREIGN KEY ("bidId") REFERENCES "IssueBid"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BidVote" ADD CONSTRAINT "BidVote_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BidVote" ADD CONSTRAINT "BidVote_onBehalfOfUserId_fkey" FOREIGN KEY ("onBehalfOfUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BidVote" ADD CONSTRAINT "BidVote_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
