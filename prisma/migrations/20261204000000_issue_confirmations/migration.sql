-- #issue-confirmations: an issue at Requires confirmation takes confirmation
-- entries, one per person: confirm (real and not a duplicate), reject (not
-- real, or a duplicate of another issue) or neutral, each with a summary and
-- a description. Replies to an entry are comments with "confirmationId" set.
-- They replace IssueValidation: kinds `real` and `duplicate` move here, and
-- kinds `format` (written by the structure route, read by nothing) and `fix`
-- (never written; fixes take test verdicts) are dropped with the table.

-- CreateEnum
CREATE TYPE "ConfirmationVerdict" AS ENUM ('confirm', 'reject', 'neutral');

-- CreateTable
CREATE TABLE "IssueConfirmation" (
    "id" TEXT NOT NULL,
    "bugId" TEXT NOT NULL,
    "onBehalfOfUserId" TEXT NOT NULL,
    "agentId" TEXT,
    "verdict" "ConfirmationVerdict" NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "Severity",
    "previousSeverity" "Severity",
    "duplicateOfId" TEXT,
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssueConfirmation_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN "confirmationId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "IssueConfirmation_bugId_onBehalfOfUserId_key" ON "IssueConfirmation"("bugId", "onBehalfOfUserId");
CREATE INDEX "IssueConfirmation_bugId_verdict_idx" ON "IssueConfirmation"("bugId", "verdict");
CREATE INDEX "IssueConfirmation_agentId_createdAt_idx" ON "IssueConfirmation"("agentId", "createdAt");
CREATE INDEX "Comment_confirmationId_idx" ON "Comment"("confirmationId");

-- AddForeignKey
ALTER TABLE "IssueConfirmation" ADD CONSTRAINT "IssueConfirmation_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueConfirmation" ADD CONSTRAINT "IssueConfirmation_onBehalfOfUserId_fkey" FOREIGN KEY ("onBehalfOfUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueConfirmation" ADD CONSTRAINT "IssueConfirmation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_confirmationId_fkey" FOREIGN KEY ("confirmationId") REFERENCES "IssueConfirmation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Move the validations of kinds `real` and `duplicate` over: one entry per
-- issue and person, from what they said there. Validations whose
-- `issue.validated` audit was undone stay out. The entry keeps the id and
-- time of the person's latest validation, so "counted only after the latest
-- edit" holds and an old audit event still finds its entry for an undo.
--   reject:  a `real` reject, or a `duplicate` accept (with its duplicateOfId)
--   confirm: otherwise, a `real` accept (with its severity)
--   neutral: otherwise (only a "not a duplicate" clearance)
WITH undone AS (
  SELECT DISTINCT "payload"->>'validationId' AS "id"
  FROM "AgentAuditEvent"
  WHERE "action" = 'issue.validated' AND "undoneAt" IS NOT NULL AND "payload"->>'validationId' IS NOT NULL
),
kept AS (
  SELECT v.*
  FROM "IssueValidation" v
  WHERE v."kind" IN ('real', 'duplicate')
    AND v."id" NOT IN (SELECT "id" FROM undone)
),
latest AS (
  SELECT DISTINCT ON ("bugId", "onBehalfOfUserId")
    "id", "bugId", "onBehalfOfUserId", "agentId", "createdAt"
  FROM kept
  ORDER BY "bugId", "onBehalfOfUserId", "createdAt" DESC, "id" DESC
),
grouped AS (
  SELECT
    k."bugId",
    k."onBehalfOfUserId",
    bool_or(k."kind" = 'real' AND k."verdict" = 'reject') AS "notReal",
    bool_or(k."kind" = 'duplicate' AND k."verdict" = 'accept') AS "duplicate",
    bool_or(k."kind" = 'real' AND k."verdict" = 'accept') AS "real",
    (array_agg(k."duplicateOfId" ORDER BY k."createdAt" DESC) FILTER (WHERE k."kind" = 'duplicate' AND k."verdict" = 'accept'))[1] AS "duplicateOfId",
    (array_agg(k."severity" ORDER BY k."createdAt" DESC) FILTER (WHERE k."kind" = 'real' AND k."verdict" = 'accept'))[1] AS "severity",
    (array_agg(k."previousSeverity" ORDER BY k."createdAt" DESC) FILTER (WHERE k."kind" = 'real' AND k."verdict" = 'accept'))[1] AS "previousSeverity",
    string_agg(NULLIF(btrim(k."notes"), ''), E'\n\n' ORDER BY k."createdAt", k."id") AS "notes"
  FROM kept k
  GROUP BY k."bugId", k."onBehalfOfUserId"
)
INSERT INTO "IssueConfirmation" (
  "id", "bugId", "onBehalfOfUserId", "agentId", "verdict", "summary", "description",
  "severity", "previousSeverity", "duplicateOfId", "createdAt", "updatedAt"
)
SELECT
  l."id",
  g."bugId",
  g."onBehalfOfUserId",
  l."agentId",
  (CASE
    WHEN g."notReal" OR g."duplicate" THEN 'reject'
    WHEN g."real" THEN 'confirm'
    ELSE 'neutral'
  END)::"ConfirmationVerdict",
  CASE
    WHEN g."duplicate" THEN 'Rejected: duplicate of another issue.'
    WHEN g."notReal" THEN 'Rejected: not a real issue.'
    WHEN g."real" AND g."severity" IS NOT NULL THEN 'Confirmed as real, severity ' || g."severity"::text || '.'
    WHEN g."real" THEN 'Confirmed as real.'
    ELSE 'Checked for duplicates and found none.'
  END,
  COALESCE(g."notes", 'Recorded before entries needed a written explanation.'),
  CASE WHEN g."real" AND NOT (g."notReal" OR g."duplicate") THEN g."severity" END,
  CASE WHEN g."real" AND NOT (g."notReal" OR g."duplicate") THEN g."previousSeverity" END,
  CASE WHEN g."duplicate" THEN g."duplicateOfId" END,
  l."createdAt",
  l."createdAt"
FROM grouped g
JOIN latest l ON l."bugId" = g."bugId" AND l."onBehalfOfUserId" = g."onBehalfOfUserId";

-- Confirming no longer waits for a separate duplicate clearance, so an issue
-- that already has enough independent confirms is confirmed now: it leaves
-- Requires confirmation for Open, as a new confirmation would move it.
WITH latest_revision AS (
  SELECT "bugId", MAX("editedAt") AS "at" FROM "BugRevision" GROUP BY "bugId"
),
counted AS (
  SELECT c."bugId", COALESCE(a."ownerUserId", c."onBehalfOfUserId") AS "ownerUserId"
  FROM "IssueConfirmation" c
  LEFT JOIN "Agent" a ON a."id" = c."agentId"
  JOIN "Bug" b ON b."id" = c."bugId"
  LEFT JOIN "Agent" filer ON filer."id" = b."createdByAgentId"
  LEFT JOIN latest_revision r ON r."bugId" = b."id"
  WHERE c."verdict" = 'confirm' AND c."undoneAt" IS NULL
    AND (r."at" IS NULL OR c."updatedAt" > r."at")
    AND c."agentId" IS DISTINCT FROM b."createdByAgentId"
    AND COALESCE(a."ownerUserId", c."onBehalfOfUserId") <> b."reporterId"
    AND COALESCE(a."ownerUserId", c."onBehalfOfUserId") IS DISTINCT FROM b."beneficiaryUserId"
    AND COALESCE(a."ownerUserId", c."onBehalfOfUserId") IS DISTINCT FROM filer."ownerUserId"
    AND c."onBehalfOfUserId" <> b."reporterId" AND c."onBehalfOfUserId" IS DISTINCT FROM b."beneficiaryUserId"
    AND c."onBehalfOfUserId" IS DISTINCT FROM filer."ownerUserId"
)
UPDATE "Bug" b
SET "status" = 'open'
FROM "Project" p
LEFT JOIN "ProjectWorkflow" w ON w."projectId" = p."id"
WHERE p."id" = b."projectId"
  AND b."status" = 'requires_confirmation'
  AND b."isDeleted" = false
  AND (SELECT COUNT(DISTINCT c."ownerUserId") FROM counted c WHERE c."bugId" = b."id") >= COALESCE(w."confirmationsNeeded", 2);

-- DropTable (its foreign keys and indexes go with it)
DROP TABLE "IssueValidation";

-- DropEnum (ValidationVerdict stays: job reviews use it)
DROP TYPE "ValidationKind";
