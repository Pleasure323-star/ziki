-- The comments people wrote while an issue waited for confirmation become
-- that stage's entries: each commenter gets a Neutral confirmation (it never
-- counts towards confirming), and their comments, with every reply under
-- them, become replies to it. Comments written after the issue was confirmed
-- stay comments on the issue. No comment is deleted or rewritten.

-- When each issue was confirmed: the earliest of its `issue.confirmed` event,
-- the status change a confirmation made, and its first claim. An issue with
-- none of these and still at Requires confirmation has every comment in that
-- stage; one past it with none has none there.
CREATE TEMP TABLE "_stage_comments" AS
WITH confirmed_at AS (
  SELECT
    b."id" AS "bugId",
    b."status",
    LEAST(
      (SELECT MIN(e."createdAt") FROM "AgentEvent" e WHERE e."bugId" = b."id" AND e."type" = 'issue.confirmed'),
      (SELECT MIN(a."createdAt") FROM "BugActivity" a
        WHERE a."bugId" = b."id" AND a."type" = 'status_changed' AND a."metadata"->>'via' = 'confirmed'),
      (SELECT MIN(COALESCE(c."offeredAt", c."claimedAt", c."createdAt")) FROM "IssueClaim" c WHERE c."bugId" = b."id")
    ) AS "at"
  FROM "Bug" b
)
SELECT c."id", c."bugId", c."authorId", c."agentId", c."createdAt"
FROM "Comment" c
JOIN confirmed_at ca ON ca."bugId" = c."bugId"
WHERE c."parentId" IS NULL
  AND c."deletedAt" IS NULL
  AND c."confirmationId" IS NULL AND c."bidId" IS NULL AND c."testVerdictId" IS NULL AND c."mergeReviewId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "IdeaVerdict" v WHERE v."commentId" = c."id")
  AND (
    (ca."at" IS NULL AND ca."status" = 'requires_confirmation')
    OR c."createdAt" < ca."at"
  );

-- 1. A Neutral confirmation for each commenter who has no entry on the issue.
INSERT INTO "IssueConfirmation" (
  "id", "bugId", "onBehalfOfUserId", "agentId", "verdict", "summary", "description", "createdAt", "updatedAt"
)
SELECT DISTINCT ON (sc."bugId", sc."authorId")
  'cnfc' || substr(md5(sc."bugId" || ':' || sc."authorId"), 1, 21),
  sc."bugId",
  sc."authorId",
  sc."agentId",
  'neutral'::"ConfirmationVerdict",
  'Commented before confirmations took entries.',
  'Recorded as neutral: this person commented while the issue awaited confirmation. Their comments are the replies below.',
  sc."createdAt",
  sc."createdAt"
FROM "_stage_comments" sc
ORDER BY sc."bugId", sc."authorId", sc."createdAt", sc."id"
ON CONFLICT ("bugId", "onBehalfOfUserId") DO NOTHING;

-- 2. Each of those comments becomes a reply to its author's confirmation.
UPDATE "Comment" c
SET "confirmationId" = ic."id"
FROM "_stage_comments" sc
JOIN "IssueConfirmation" ic ON ic."bugId" = sc."bugId" AND ic."onBehalfOfUserId" = sc."authorId"
WHERE c."id" = sc."id";

-- 3. Every reply under them, at any depth, goes with them.
WITH RECURSIVE tree AS (
  SELECT c."id", c."confirmationId"
  FROM "Comment" c
  WHERE c."id" IN (SELECT "id" FROM "_stage_comments")
  UNION ALL
  SELECT child."id", tree."confirmationId"
  FROM "Comment" child
  JOIN tree ON child."parentId" = tree."id"
)
UPDATE "Comment" c
SET "confirmationId" = tree."confirmationId"
FROM tree
WHERE c."id" = tree."id"
  AND c."confirmationId" IS NULL
  AND c."bidId" IS NULL AND c."testVerdictId" IS NULL AND c."mergeReviewId" IS NULL;

DROP TABLE "_stage_comments";
