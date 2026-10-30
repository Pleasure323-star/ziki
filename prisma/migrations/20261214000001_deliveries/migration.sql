-- Work delivered (#delivered-step). In progress gets its own entry: the agent
-- holding the claim delivers its work (a summary, a description, the pull
-- request and the evidence), and the issue moves to Delivered, where
-- independent agents judge it.
--
-- 1. The Delivery table and replies to it (Comment.deliveryId).
-- 2. A delivery for every issue that already has a linked pull request, from
--    the agent that linked it (the `github.linked` audit row), else the agent
--    whose claim delivered it (the active claim, else the last released one).
-- 3. Issues In progress with a delivery move to Delivered, except a fix a
--    manager rejected on that same pull request (it is being reworked).
-- 4. Delivered issues whose good-to-merge judgements already meet the rule move
--    to Done: the same count as the app (lib/agent-api/merge-verdicts.ts
--    countedMergeVerdicts with deliveredClaim, and lib/agents/independence.ts):
--    verdicts on the linked pull request, none from the delivering claim's
--    agent or its owner, none from anyone not independent of the issue (by the
--    agent's owner or the person credited), one per owner, against the
--    project's verdictsNeeded (2 when unset).
--
-- Safe to run again: every step skips what is already done.

CREATE TABLE IF NOT EXISTS "Delivery" (
    "id" TEXT NOT NULL,
    "bugId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "beneficiaryUserId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "pullRequestUrl" TEXT NOT NULL,
    "headSha" TEXT,
    "screenshots" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "testResults" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Delivery_bugId_createdAt_idx" ON "Delivery"("bugId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "Delivery_bugId_agentId_key" ON "Delivery"("bugId", "agentId");

ALTER TABLE "Comment" ADD COLUMN IF NOT EXISTS "deliveryId" TEXT;
CREATE INDEX IF NOT EXISTS "Comment_deliveryId_idx" ON "Comment"("deliveryId");

DO $$ BEGIN
  ALTER TABLE "Comment" ADD CONSTRAINT "Comment_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_beneficiaryUserId_fkey" FOREIGN KEY ("beneficiaryUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. A delivery for each issue with a linked pull request and none yet.
INSERT INTO "Delivery" ("id", "bugId", "agentId", "beneficiaryUserId", "summary", "description", "pullRequestUrl", "headSha", "screenshots", "testResults", "createdAt", "updatedAt")
SELECT
  'dlv' || substr(md5(s.bug_id || ':' || s.agent_id), 1, 22),
  s.bug_id,
  s.agent_id,
  s.beneficiary,
  CASE WHEN s.pr_number IS NOT NULL THEN 'Delivered the fix in pull request #' || s.pr_number || '.' ELSE 'Delivered the fix.' END,
  'Recorded from the pull request linked on ' || to_char(s.delivered_at, 'YYYY-MM-DD')
    || ', before delivered work was an entry of its own.'
    || CASE WHEN s.test_results IS NOT NULL THEN E'\n\nTest results:\n' || s.test_results ELSE '' END,
  s.pr_url,
  s.head_sha,
  s.screenshots,
  s.test_results,
  s.delivered_at,
  s.delivered_at
FROM (
  SELECT
    b."id" AS bug_id,
    b."pullRequestUrl" AS pr_url,
    b."pullRequestHeadSha" AS head_sha,
    substring(b."pullRequestUrl" from '/pull/([0-9]+)') AS pr_number,
    COALESCE(au."agentId", dc."agentId") AS agent_id,
    COALESCE(own."beneficiaryUserId", dc."beneficiaryUserId", ag."ownerUserId") AS beneficiary,
    COALESCE(au."createdAt", b."updatedAt") AS delivered_at,
    CASE
      WHEN jsonb_typeof(au."payload"::jsonb -> 'testResults') = 'string' THEN au."payload"::jsonb ->> 'testResults'
      WHEN au."payload"::jsonb -> 'testResults' IS NOT NULL THEN (au."payload"::jsonb -> 'testResults')::text
    END AS test_results,
    CASE
      WHEN jsonb_typeof(au."payload"::jsonb -> 'screenshots') = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text(au."payload"::jsonb -> 'screenshots'))
      ELSE ARRAY[]::TEXT[]
    END AS screenshots
  FROM "Bug" b
  -- The agent that linked it, and what it sent.
  LEFT JOIN LATERAL (
    SELECT e."agentId", e."payload", e."createdAt"
    FROM "AgentAuditEvent" e
    WHERE e."bugId" = b."id" AND e."action" = 'github.linked'
    ORDER BY e."createdAt" DESC, e."id" DESC
    LIMIT 1
  ) au ON true
  -- The claim the fix was delivered under: the active one, else the last one let go.
  LEFT JOIN LATERAL (
    SELECT c."agentId", c."beneficiaryUserId"
    FROM "IssueClaim" c
    WHERE c."bugId" = b."id"
      AND ((c."status" = 'active' AND c."releasedAt" IS NULL)
        OR (c."status" = 'released' AND c."claimedAt" IS NOT NULL AND c."releasedAt" IS NOT NULL))
    ORDER BY (c."status" = 'active' AND c."releasedAt" IS NULL) DESC, c."releasedAt" DESC NULLS LAST, c."id" DESC
    LIMIT 1
  ) dc ON true
  -- For the agent that linked it: the person its claim on this issue was for.
  LEFT JOIN LATERAL (
    SELECT c."beneficiaryUserId"
    FROM "IssueClaim" c
    WHERE c."bugId" = b."id" AND c."agentId" = au."agentId" AND c."claimedAt" IS NOT NULL
    ORDER BY c."claimedAt" DESC, c."id" DESC
    LIMIT 1
  ) own ON true
  LEFT JOIN "Agent" ag ON ag."id" = COALESCE(au."agentId", dc."agentId")
  WHERE b."pullRequestUrl" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "Delivery" d WHERE d."bugId" = b."id")
) s
WHERE s.agent_id IS NOT NULL AND s.beneficiary IS NOT NULL
ON CONFLICT ("bugId", "agentId") DO NOTHING;

-- 3. Delivered work moves to Delivered, unless a manager rejected that pull request.
UPDATE "Bug" b
SET "status" = 'delivered'
WHERE b."status" = 'in_progress'
  AND b."pullRequestUrl" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "Delivery" d WHERE d."bugId" = b."id")
  AND NOT EXISTS (
    SELECT 1
    FROM (
      SELECT mr."verdict", mr."pullRequestUrl"
      FROM "MergeReview" mr
      WHERE mr."bugId" = b."id"
      ORDER BY mr."updatedAt" DESC, mr."id" DESC
      LIMIT 1
    ) latest
    WHERE latest."verdict" = 'reject' AND latest."pullRequestUrl" = b."pullRequestUrl"
  );

-- 4. Delivered issues whose judgements already meet the rule are Done.
WITH counted AS (
  SELECT b."id" AS bug_id, COUNT(DISTINCT va."ownerUserId") AS reviewers
  FROM "Bug" b
  JOIN "TestVerdict" v ON v."bugId" = b."id" AND v."goodToMerge" = true AND v."pullRequestUrl" = b."pullRequestUrl"
  JOIN "Agent" va ON va."id" = v."agentId"
  LEFT JOIN "Agent" cba ON cba."id" = b."createdByAgentId"
  -- The claim the fix was delivered under (deliveredClaim).
  LEFT JOIN LATERAL (
    SELECT c."agentId"
    FROM "IssueClaim" c
    WHERE c."bugId" = b."id"
      AND ((c."status" = 'active' AND c."releasedAt" IS NULL)
        OR (c."status" = 'released' AND c."claimedAt" IS NOT NULL AND c."releasedAt" IS NOT NULL))
    ORDER BY (c."status" = 'active' AND c."releasedAt" IS NULL) DESC, c."releasedAt" DESC NULLS LAST, c."id" DESC
    LIMIT 1
  ) dc ON true
  LEFT JOIN "Agent" dca ON dca."id" = dc."agentId"
  -- The active claim, which the independence rules read.
  LEFT JOIN LATERAL (
    SELECT c."agentId", c."beneficiaryUserId", c."dispatcherUserId"
    FROM "IssueClaim" c
    WHERE c."bugId" = b."id" AND c."status" = 'active' AND c."releasedAt" IS NULL
    ORDER BY c."createdAt" ASC, c."id" ASC
    LIMIT 1
  ) ac ON true
  LEFT JOIN "Agent" aca ON aca."id" = ac."agentId"
  WHERE b."status" = 'delivered'
    -- Not from the delivering claim's agent or its owner.
    AND NOT (dc."agentId" IS NOT NULL AND (v."agentId" = dc."agentId" OR va."ownerUserId" IS NOT DISTINCT FROM dca."ownerUserId"))
    -- Independent of the issue, by the agent's owner and by the person credited.
    AND NOT EXISTS (
      SELECT 1
      FROM (VALUES (va."ownerUserId"), (v."onBehalfOfUserId")) AS who(person)
      WHERE who.person IS NOT DISTINCT FROM cba."ownerUserId"
         OR who.person IS NOT DISTINCT FROM b."beneficiaryUserId"
         OR who.person IS NOT DISTINCT FROM b."reporterId"
         OR who.person IS NOT DISTINCT FROM aca."ownerUserId"
         OR who.person IS NOT DISTINCT FROM b."assigneeId"
         OR who.person IS NOT DISTINCT FROM ac."beneficiaryUserId"
         OR who.person IS NOT DISTINCT FROM ac."dispatcherUserId"
    )
  GROUP BY b."id"
)
UPDATE "Bug" b
SET "status" = 'done'
FROM counted
WHERE b."id" = counted.bug_id
  AND b."status" = 'delivered'
  AND counted.reviewers >= COALESCE((SELECT w."verdictsNeeded" FROM "ProjectWorkflow" w WHERE w."projectId" = b."projectId"), 2);
