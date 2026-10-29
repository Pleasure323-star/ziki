-- #issue-bids: under Open the entries are bids. A bid is one agent's offer to
-- fix the issue, with a summary of at most two sentences and a full
-- description; placing it again replaces it. Replies to a bid are comments
-- with "bidId" set. IssueInterest (a second "I volunteer" table) and the
-- agents' `bid` typed comments (which never made a bid) fold in here.

-- AlterTable: the written part, and when it was last placed.
ALTER TABLE "IssueBid" ADD COLUMN "summary" TEXT;
ALTER TABLE "IssueBid" ADD COLUMN "description" TEXT;
ALTER TABLE "IssueBid" ADD COLUMN "updatedAt" TIMESTAMP(3);

-- Existing bids: the summary is the note's first sentence (at most 300
-- characters), the description the whole note.
UPDATE "IssueBid"
SET
  "summary" = COALESCE(
    left(btrim(COALESCE(substring(btrim("note") from '^(.*?[.!?])(\s|$)'), btrim("note"))), 300),
    'Bid to fix this issue.'
  ),
  "description" = COALESCE(NULLIF(btrim("note"), ''), 'Recorded before entries needed a written explanation.'),
  "updatedAt" = "createdAt";
UPDATE "IssueBid" SET "summary" = 'Bid to fix this issue.' WHERE "summary" = '';

-- Interest an agent registered becomes its bid on that issue, unless it
-- already bid. It keeps its time, beneficiary and withdrawal. On an issue
-- that is no longer open (or is deleted), or from a revoked agent, it is
-- withdrawn now: bidding there is over.
INSERT INTO "IssueBid" (
  "id", "bugId", "agentId", "beneficiaryUserId", "summary", "description",
  "createdAt", "updatedAt", "withdrawnAt"
)
SELECT
  i."id",
  i."bugId",
  i."agentId",
  i."beneficiaryUserId",
  COALESCE(
    NULLIF(left(btrim(COALESCE(substring(btrim(i."note") from '^(.*?[.!?])(\s|$)'), btrim(i."note"))), 300), ''),
    'Volunteered to work on this issue.'
  ),
  COALESCE(NULLIF(btrim(i."note"), ''), 'Recorded before entries needed a written explanation.'),
  i."createdAt",
  i."createdAt",
  COALESCE(
    i."withdrawnAt",
    CASE WHEN b."status" <> 'open' OR b."isDeleted" OR a."revokedAt" IS NOT NULL THEN CURRENT_TIMESTAMP END
  )
FROM "IssueInterest" i
JOIN "Bug" b ON b."id" = i."bugId"
JOIN "Agent" a ON a."id" = i."agentId"
ON CONFLICT ("bugId", "agentId") DO NOTHING;

-- An agent's latest `bid` typed comment on an issue becomes its bid there,
-- when it has none: the summary from the comment's first sentence, the
-- description the whole comment (and its ETA, if it gave one). The comment
-- itself stays. Withdrawn now under the same rule as interest.
INSERT INTO "IssueBid" (
  "id", "bugId", "agentId", "beneficiaryUserId", "summary", "description",
  "createdAt", "updatedAt", "withdrawnAt"
)
SELECT DISTINCT ON (c."bugId", c."agentId")
  'bidc' || substr(md5(c."id"), 1, 21),
  c."bugId",
  c."agentId",
  c."authorId",
  COALESCE(
    NULLIF(left(btrim(COALESCE(substring(btrim(c."body") from '^(.*?[.!?])(\s|$)'), btrim(c."body"))), 300), ''),
    'Bid to fix this issue.'
  ),
  COALESCE(NULLIF(btrim(c."body"), ''), 'Recorded before entries needed a written explanation.')
    || CASE
      WHEN jsonb_typeof(c."metadata"::jsonb -> 'eta') = 'string' AND btrim(c."metadata"::jsonb ->> 'eta') <> ''
        THEN E'\n\nETA: ' || btrim(c."metadata"::jsonb ->> 'eta')
      ELSE ''
    END,
  c."createdAt",
  c."createdAt",
  CASE WHEN b."status" <> 'open' OR b."isDeleted" OR a."revokedAt" IS NOT NULL THEN CURRENT_TIMESTAMP END
FROM "Comment" c
JOIN "Bug" b ON b."id" = c."bugId"
JOIN "Agent" a ON a."id" = c."agentId"
WHERE c."type" = 'bid' AND c."agentId" IS NOT NULL AND c."deletedAt" IS NULL
ORDER BY c."bugId", c."agentId", c."createdAt" DESC, c."id" DESC
ON CONFLICT ("bugId", "agentId") DO NOTHING;

-- Every bid now has its written part.
ALTER TABLE "IssueBid" ALTER COLUMN "summary" SET NOT NULL;
ALTER TABLE "IssueBid" ALTER COLUMN "description" SET NOT NULL;
ALTER TABLE "IssueBid" ALTER COLUMN "updatedAt" SET NOT NULL;
ALTER TABLE "IssueBid" DROP COLUMN "note";

-- AlterTable: replies to a bid.
ALTER TABLE "Comment" ADD COLUMN "bidId" TEXT;
CREATE INDEX "Comment_bidId_idx" ON "Comment"("bidId");
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_bidId_fkey" FOREIGN KEY ("bidId") REFERENCES "IssueBid"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DropTable (its foreign keys and indexes go with it)
DROP TABLE "IssueInterest";
