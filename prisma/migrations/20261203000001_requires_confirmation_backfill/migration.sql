-- #requires-confirmation: new issues start at "Requires confirmation".
ALTER TABLE "Bug" ALTER COLUMN "status" SET DEFAULT 'requires_confirmation';

-- Open issues that are not confirmed yet move there. Confirmed is the rule of
-- isConfirmed() (lib/agent-api/validation.ts): the project's required number
-- of independent owners accepted it as real, AND an independent agent cleared
-- it as not a duplicate. Only reviews after the latest edit count, an undone
-- review never counts, and neither the filing agent nor anyone the issue is
-- filed by or for may count.
WITH latest_revision AS (
  SELECT "bugId", MAX("editedAt") AS "at" FROM "BugRevision" GROUP BY "bugId"
),
undone AS (
  SELECT DISTINCT "payload"->>'validationId' AS "id"
  FROM "AgentAuditEvent"
  WHERE "action" = 'issue.validated' AND "undoneAt" IS NOT NULL AND "payload"->>'validationId' IS NOT NULL
),
counted AS (
  SELECT v."bugId", v."kind", a."ownerUserId"
  FROM "IssueValidation" v
  JOIN "Agent" a ON a."id" = v."agentId"
  JOIN "Bug" b ON b."id" = v."bugId"
  LEFT JOIN "Agent" filer ON filer."id" = b."createdByAgentId"
  LEFT JOIN latest_revision r ON r."bugId" = b."id"
  WHERE ((v."kind" = 'real' AND v."verdict" = 'accept') OR (v."kind" = 'duplicate' AND v."verdict" = 'reject'))
    AND (r."at" IS NULL OR v."createdAt" > r."at")
    AND v."agentId" IS DISTINCT FROM b."createdByAgentId"
    AND a."ownerUserId" <> b."reporterId" AND a."ownerUserId" <> b."beneficiaryUserId"
    AND a."ownerUserId" IS DISTINCT FROM filer."ownerUserId"
    AND v."onBehalfOfUserId" <> b."reporterId" AND v."onBehalfOfUserId" <> b."beneficiaryUserId"
    AND v."onBehalfOfUserId" IS DISTINCT FROM filer."ownerUserId"
    AND v."id" NOT IN (SELECT "id" FROM undone)
),
confirmed AS (
  SELECT b."id"
  FROM "Bug" b
  LEFT JOIN "ProjectWorkflow" w ON w."projectId" = b."projectId"
  WHERE (SELECT COUNT(DISTINCT c."ownerUserId") FROM counted c WHERE c."bugId" = b."id" AND c."kind" = 'real')
          >= COALESCE(w."confirmationsNeeded", 2)
    AND EXISTS (SELECT 1 FROM counted c WHERE c."bugId" = b."id" AND c."kind" = 'duplicate')
)
UPDATE "Bug"
SET "status" = 'requires_confirmation'
WHERE "status" = 'open' AND "id" NOT IN (SELECT "id" FROM confirmed);
