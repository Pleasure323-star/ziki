-- #review-entries: the review stages take entries too. At Done each tester's
-- test verdict (good / not good to merge) carries a summary of at most two
-- sentences and a full description, in place of optional notes. At Ready to
-- merge a manager agent's accept or reject is a MergeReview entry, in place of
-- the narration comments it used to post. Replies to either are comments with
-- "testVerdictId" or "mergeReviewId" set. The old narration comments stay.

-- AlterTable: the written part of a test verdict, and when it was last given.
ALTER TABLE "TestVerdict" ADD COLUMN "summary" TEXT;
ALTER TABLE "TestVerdict" ADD COLUMN "description" TEXT;
ALTER TABLE "TestVerdict" ADD COLUMN "updatedAt" TIMESTAMP(3);

-- Existing verdicts: a generated summary, the notes as the description.
UPDATE "TestVerdict"
SET
  "summary" = CASE WHEN "goodToMerge" THEN 'Good to merge.' ELSE 'Not good to merge.' END,
  "description" = COALESCE(NULLIF(btrim("notes"), ''), 'Recorded before entries needed a written explanation.'),
  "updatedAt" = COALESCE("changedAt", "createdAt");

ALTER TABLE "TestVerdict" ALTER COLUMN "summary" SET NOT NULL;
ALTER TABLE "TestVerdict" ALTER COLUMN "description" SET NOT NULL;
ALTER TABLE "TestVerdict" ALTER COLUMN "updatedAt" SET NOT NULL;
ALTER TABLE "TestVerdict" DROP COLUMN "notes";

-- CreateEnum
CREATE TYPE "MergeReviewVerdict" AS ENUM ('accept', 'reject');

-- CreateTable
CREATE TABLE "MergeReview" (
    "id" TEXT NOT NULL,
    "bugId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "onBehalfOfUserId" TEXT NOT NULL,
    "verdict" "MergeReviewVerdict" NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "pullRequestUrl" TEXT NOT NULL,
    "headSha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MergeReview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MergeReview_bugId_updatedAt_idx" ON "MergeReview"("bugId", "updatedAt");
CREATE UNIQUE INDEX "MergeReview_bugId_agentId_key" ON "MergeReview"("bugId", "agentId");

ALTER TABLE "MergeReview" ADD CONSTRAINT "MergeReview_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MergeReview" ADD CONSTRAINT "MergeReview_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MergeReview" ADD CONSTRAINT "MergeReview_onBehalfOfUserId_fkey" FOREIGN KEY ("onBehalfOfUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Past manager decisions become merge reviews: each agent's latest accept
-- (`issue.accepted` that only marked the fix ready to merge; one carrying
-- `merged: true` was the admin merge, an action) or reject
-- (`issue.merge_rejected`) on an issue, unless it was undone. It is about the
-- pull request the event names, or else the issue's current one; an event
-- with neither reviewed nothing and is skipped. A reject's description is the
-- feedback it gave (its payload's notes, or else the narration comment the
-- same agent posted with it); the stock "Fix rejected by merger agent." and
-- every accept, whose narration was boilerplate, get the generated one.
WITH decisions AS (
  SELECT DISTINCT ON (e."bugId", e."agentId")
    e."id",
    e."bugId",
    e."agentId",
    a."ownerUserId",
    e."action",
    e."createdAt",
    COALESCE(NULLIF(btrim(e."payload" ->> 'pullRequestUrl'), ''), b."pullRequestUrl") AS "pullRequestUrl",
    NULLIF(btrim(e."payload" ->> 'headSha'), '') AS "headSha",
    CASE WHEN e."action" = 'issue.merge_rejected' THEN
      NULLIF(
        NULLIF(
          btrim(COALESCE(
            NULLIF(btrim(e."payload" ->> 'notes'), ''),
            (
              SELECT c."body"
              FROM "Comment" c
              WHERE c."bugId" = e."bugId"
                AND c."agentId" = e."agentId"
                AND c."deletedAt" IS NULL
                AND c."createdAt" BETWEEN e."createdAt" - INTERVAL '5 seconds' AND e."createdAt" + INTERVAL '5 seconds'
              ORDER BY abs(extract(epoch FROM (c."createdAt" - e."createdAt"))), c."id"
              LIMIT 1
            )
          )),
          ''
        ),
        'Fix rejected by merger agent.'
      )
    END AS "feedback"
  FROM "AgentAuditEvent" e
  JOIN "Agent" a ON a."id" = e."agentId"
  JOIN "Bug" b ON b."id" = e."bugId"
  WHERE e."action" IN ('issue.accepted', 'issue.merge_rejected')
    AND e."undoneAt" IS NULL
    AND NOT (e."action" = 'issue.accepted' AND COALESCE(e."payload" ->> 'merged', '') = 'true')
  ORDER BY e."bugId", e."agentId", e."createdAt" DESC, e."id" DESC
)
INSERT INTO "MergeReview" (
  "id", "bugId", "agentId", "onBehalfOfUserId", "verdict", "summary", "description",
  "pullRequestUrl", "headSha", "createdAt", "updatedAt"
)
SELECT
  'mrev' || substr(md5(d."id"), 1, 21),
  d."bugId",
  d."agentId",
  d."ownerUserId",
  CASE WHEN d."action" = 'issue.merge_rejected' THEN 'reject' ELSE 'accept' END::"MergeReviewVerdict",
  CASE
    WHEN d."action" = 'issue.accepted' THEN 'Accepted for merging.'
    ELSE COALESCE(
      NULLIF(left(btrim(COALESCE(substring(d."feedback" from '^(.*?[.!?])(\s|$)'), d."feedback")), 300), ''),
      'Rejected for merging.'
    )
  END,
  COALESCE(d."feedback", 'Recorded before entries needed a written explanation.'),
  d."pullRequestUrl",
  d."headSha",
  d."createdAt",
  d."createdAt"
FROM decisions d
WHERE d."pullRequestUrl" IS NOT NULL;

-- AlterTable: replies to a test verdict or a merge review.
ALTER TABLE "Comment" ADD COLUMN "testVerdictId" TEXT;
ALTER TABLE "Comment" ADD COLUMN "mergeReviewId" TEXT;
CREATE INDEX "Comment_testVerdictId_idx" ON "Comment"("testVerdictId");
CREATE INDEX "Comment_mergeReviewId_idx" ON "Comment"("mergeReviewId");
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_testVerdictId_fkey" FOREIGN KEY ("testVerdictId") REFERENCES "TestVerdict"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_mergeReviewId_fkey" FOREIGN KEY ("mergeReviewId") REFERENCES "MergeReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
