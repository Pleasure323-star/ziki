-- The comments people wrote while an issue waited for confirmation become
-- that stage's entries: each commenter gets a Neutral confirmation (it never
-- counts towards confirming), and their comments, with every reply under
-- them, become replies to it. Comments written after the issue was confirmed
-- stay comments on the issue. No comment is deleted or rewritten.
--
-- Each statement stands alone (no temporary table), and each source table is
-- read once and grouped, so the migration stays quick on a large database.

-- When each issue was confirmed: the earliest of its `issue.confirmed` event,
-- the status change a confirmation made, and its first claim. An issue with
-- none of these and still at Requires confirmation has every comment in that
-- stage; one past it with none has none there.

-- 1. A Neutral confirmation for each commenter who has no entry on the issue.
WITH confirmed_events AS (
  SELECT "bugId", MIN("createdAt") AS "at" FROM "AgentEvent"
  WHERE "type" = 'issue.confirmed' AND "bugId" IS NOT NULL GROUP BY "bugId"
),
confirmed_activity AS (
  SELECT "bugId", MIN("createdAt") AS "at" FROM "BugActivity"
  WHERE "type" = 'status_changed' AND "metadata"->>'via' = 'confirmed' GROUP BY "bugId"
),
first_claims AS (
  SELECT "bugId", MIN(COALESCE("offeredAt", "claimedAt", "createdAt")) AS "at" FROM "IssueClaim" GROUP BY "bugId"
),
confirmed_at AS (
  SELECT b."id" AS "bugId", b."status", LEAST(e."at", a."at", c."at") AS "at"
  FROM "Bug" b
  LEFT JOIN confirmed_events e ON e."bugId" = b."id"
  LEFT JOIN confirmed_activity a ON a."bugId" = b."id"
  LEFT JOIN first_claims c ON c."bugId" = b."id"
),
stage_comments AS (
  SELECT c."id", c."bugId", c."authorId", c."agentId", c."createdAt"
  FROM "Comment" c
  JOIN confirmed_at ca ON ca."bugId" = c."bugId"
  WHERE c."parentId" IS NULL
    AND c."deletedAt" IS NULL
    AND c."confirmationId" IS NULL AND c."bidId" IS NULL AND c."testVerdictId" IS NULL AND c."mergeReviewId" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "IdeaVerdict" v WHERE v."commentId" = c."id")
    AND ((ca."at" IS NULL AND ca."status" = 'requires_confirmation') OR c."createdAt" < ca."at")
)
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
FROM stage_comments sc
ORDER BY sc."bugId", sc."authorId", sc."createdAt", sc."id"
ON CONFLICT ("bugId", "onBehalfOfUserId") DO NOTHING;

-- 2. Each of those comments becomes a reply to its author's confirmation.
WITH confirmed_events AS (
  SELECT "bugId", MIN("createdAt") AS "at" FROM "AgentEvent"
  WHERE "type" = 'issue.confirmed' AND "bugId" IS NOT NULL GROUP BY "bugId"
),
confirmed_activity AS (
  SELECT "bugId", MIN("createdAt") AS "at" FROM "BugActivity"
  WHERE "type" = 'status_changed' AND "metadata"->>'via' = 'confirmed' GROUP BY "bugId"
),
first_claims AS (
  SELECT "bugId", MIN(COALESCE("offeredAt", "claimedAt", "createdAt")) AS "at" FROM "IssueClaim" GROUP BY "bugId"
),
confirmed_at AS (
  SELECT b."id" AS "bugId", b."status", LEAST(e."at", a."at", c."at") AS "at"
  FROM "Bug" b
  LEFT JOIN confirmed_events e ON e."bugId" = b."id"
  LEFT JOIN confirmed_activity a ON a."bugId" = b."id"
  LEFT JOIN first_claims c ON c."bugId" = b."id"
),
stage_comments AS (
  SELECT c."id", c."bugId", c."authorId"
  FROM "Comment" c
  JOIN confirmed_at ca ON ca."bugId" = c."bugId"
  WHERE c."parentId" IS NULL
    AND c."deletedAt" IS NULL
    AND c."confirmationId" IS NULL AND c."bidId" IS NULL AND c."testVerdictId" IS NULL AND c."mergeReviewId" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "IdeaVerdict" v WHERE v."commentId" = c."id")
    AND ((ca."at" IS NULL AND ca."status" = 'requires_confirmation') OR c."createdAt" < ca."at")
)
UPDATE "Comment" c
SET "confirmationId" = ic."id"
FROM stage_comments sc
JOIN "IssueConfirmation" ic ON ic."bugId" = sc."bugId" AND ic."onBehalfOfUserId" = sc."authorId"
WHERE c."id" = sc."id";

-- 3. Every reply under them, at any depth, goes with them. The depth guard
-- ends the walk even if parent links ever loop.
WITH RECURSIVE tree AS (
  SELECT c."id", c."confirmationId", 0 AS "depth"
  FROM "Comment" c
  WHERE c."confirmationId" IS NOT NULL
    AND c."parentId" IS NULL
    AND EXISTS (SELECT 1 FROM "Comment" child WHERE child."parentId" = c."id")
  UNION ALL
  SELECT child."id", tree."confirmationId", tree."depth" + 1
  FROM "Comment" child
  JOIN tree ON child."parentId" = tree."id"
  WHERE tree."depth" < 50
)
UPDATE "Comment" c
SET "confirmationId" = tree."confirmationId"
FROM tree
WHERE c."id" = tree."id"
  AND c."confirmationId" IS NULL
  AND c."bidId" IS NULL AND c."testVerdictId" IS NULL AND c."mergeReviewId" IS NULL;
