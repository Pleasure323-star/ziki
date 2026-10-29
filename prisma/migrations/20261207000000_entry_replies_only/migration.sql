-- #entry-replies-only: an issue takes no free-standing or typed comments. A
-- new comment is a plain reply to one stage entry (a confirmation, a bid, a
-- test verdict or a merge review); stage decisions are the entries. Comments
-- written before this stay: where an old typed comment clearly belongs to an
-- entry it becomes a reply to it, and the rest show read-only as "Earlier
-- comments" on the issue page. No comment is deleted.

-- 1. An agent's `bid` comment becomes a reply to that agent's bid on the
-- issue (one bid per agent per issue, so it is never ambiguous). Only a
-- top-level comment nobody replied to moves: a thread with replies stays
-- whole among the earlier comments.
UPDATE "Comment" c
SET "bidId" = ib."id"
FROM "IssueBid" ib
WHERE c."type" = 'bid'
  AND c."agentId" IS NOT NULL
  AND c."parentId" IS NULL
  AND c."confirmationId" IS NULL AND c."bidId" IS NULL AND c."testVerdictId" IS NULL AND c."mergeReviewId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Comment" r WHERE r."parentId" = c."id")
  AND ib."bugId" = c."bugId"
  AND ib."agentId" = c."agentId";

-- 2. An agent's `review` comment becomes a reply to that agent's entry from
-- the period it was posted in: before the issue's first claim it reviewed the
-- issue (its confirmation), after it the fix (its test verdict or merge
-- review). Only when exactly one such entry exists; otherwise it stays.
-- Comments an idea verdict was given with stay with the idea.
WITH first_claim AS (
  SELECT "bugId", MIN("claimedAt") AS "at"
  FROM "IssueClaim"
  WHERE "claimedAt" IS NOT NULL
  GROUP BY "bugId"
),
reviews AS (
  SELECT c."id", c."bugId", c."agentId", (fc."at" IS NULL OR c."createdAt" < fc."at") AS "beforeClaim"
  FROM "Comment" c
  LEFT JOIN first_claim fc ON fc."bugId" = c."bugId"
  WHERE c."type" = 'review'
    AND c."agentId" IS NOT NULL
    AND c."parentId" IS NULL
    AND c."confirmationId" IS NULL AND c."bidId" IS NULL AND c."testVerdictId" IS NULL AND c."mergeReviewId" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "Comment" r WHERE r."parentId" = c."id")
    AND NOT EXISTS (SELECT 1 FROM "IdeaVerdict" v WHERE v."commentId" = c."id")
),
candidates AS (
  SELECT r."id" AS "commentId", 'confirmation' AS "kind", e."id" AS "entryId"
  FROM reviews r
  JOIN "IssueConfirmation" e ON e."bugId" = r."bugId" AND e."agentId" = r."agentId"
  WHERE r."beforeClaim"
  UNION ALL
  SELECT r."id", 'test', e."id"
  FROM reviews r
  JOIN "TestVerdict" e ON e."bugId" = r."bugId" AND e."agentId" = r."agentId"
  WHERE NOT r."beforeClaim"
  UNION ALL
  SELECT r."id", 'merge', e."id"
  FROM reviews r
  JOIN "MergeReview" e ON e."bugId" = r."bugId" AND e."agentId" = r."agentId"
  WHERE NOT r."beforeClaim"
),
unambiguous AS (
  SELECT "commentId", MIN("kind") AS "kind", MIN("entryId") AS "entryId"
  FROM candidates
  GROUP BY "commentId"
  HAVING COUNT(*) = 1
)
UPDATE "Comment" c
SET
  "confirmationId" = CASE WHEN u."kind" = 'confirmation' THEN u."entryId" END,
  "testVerdictId" = CASE WHEN u."kind" = 'test' THEN u."entryId" END,
  "mergeReviewId" = CASE WHEN u."kind" = 'merge' THEN u."entryId" END
FROM unambiguous u
WHERE c."id" = u."commentId";

-- 3. What typed comments carried beside their body (an ETA, a verdict, a pull
-- request, a self-reported confidence and its reason) is kept in the body,
-- so dropping the column loses nothing anyone wrote.
UPDATE "Comment"
SET "body" = "body"
  || CASE WHEN jsonb_typeof("metadata"::jsonb -> 'eta') = 'string' AND btrim("metadata"::jsonb ->> 'eta') <> ''
       THEN E'\n\nETA: ' || btrim("metadata"::jsonb ->> 'eta') ELSE '' END
  || CASE WHEN jsonb_typeof("metadata"::jsonb -> 'verdict') = 'string' AND btrim("metadata"::jsonb ->> 'verdict') <> ''
       THEN E'\n\nVerdict: ' || btrim("metadata"::jsonb ->> 'verdict') ELSE '' END
  || CASE WHEN jsonb_typeof("metadata"::jsonb -> 'prUrl') = 'string' AND btrim("metadata"::jsonb ->> 'prUrl') <> ''
       THEN E'\n\nPull request: ' || btrim("metadata"::jsonb ->> 'prUrl') ELSE '' END
  || CASE WHEN jsonb_typeof("metadata"::jsonb -> 'confidence') = 'number'
       THEN E'\n\nSelf-reported confidence: ' || ("metadata"::jsonb ->> 'confidence') || '%'
         || CASE WHEN jsonb_typeof("metadata"::jsonb -> 'confidenceReason') = 'string' AND btrim("metadata"::jsonb ->> 'confidenceReason') <> ''
              THEN ' — ' || btrim("metadata"::jsonb ->> 'confidenceReason') ELSE '' END
       ELSE '' END
WHERE "deletedAt" IS NULL
  AND jsonb_typeof("metadata"::jsonb) = 'object'
  AND (
    (jsonb_typeof("metadata"::jsonb -> 'eta') = 'string' AND btrim("metadata"::jsonb ->> 'eta') <> '')
    OR (jsonb_typeof("metadata"::jsonb -> 'verdict') = 'string' AND btrim("metadata"::jsonb ->> 'verdict') <> '')
    OR (jsonb_typeof("metadata"::jsonb -> 'prUrl') = 'string' AND btrim("metadata"::jsonb ->> 'prUrl') <> '')
    OR jsonb_typeof("metadata"::jsonb -> 'confidence') = 'number'
  );

-- 4. Comments have no type and no metadata any more.
DROP INDEX IF EXISTS "Comment_bugId_type_idx";
ALTER TABLE "Comment" DROP COLUMN "type";
ALTER TABLE "Comment" DROP COLUMN "metadata";
DROP TYPE "CommentType";
