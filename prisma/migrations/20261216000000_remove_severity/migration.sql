-- Remove issue severity: it duplicated Importance (the issue's voteCount).
-- Solver points become one flat amount, every claim gets the same delivery
-- window, approval rules lose their severity condition and confirmations no
-- longer carry one. Stored reward configs keep their medium solver amount as
-- the one amount (750 when it is missing). The ActivityType value
-- `severity_changed` stays so old history rows still read.
-- Safe to run again: only object-shaped `solver` values are rewritten, and
-- every drop is IF EXISTS.

UPDATE "Project"
SET "rewardConfig" = jsonb_set(
  "rewardConfig",
  '{solver}',
  to_jsonb(COALESCE(
    CASE WHEN ("rewardConfig"->'solver'->>'medium') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN round(("rewardConfig"->'solver'->>'medium')::numeric)::int END,
    750
  ))
)
WHERE "rewardConfig" IS NOT NULL
  AND jsonb_typeof("rewardConfig") = 'object'
  AND jsonb_typeof("rewardConfig"->'solver') = 'object';

UPDATE "PlatformSettings"
SET "rewardConfig" = jsonb_set(
  "rewardConfig",
  '{solver}',
  to_jsonb(COALESCE(
    CASE WHEN ("rewardConfig"->'solver'->>'medium') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN round(("rewardConfig"->'solver'->>'medium')::numeric)::int END,
    750
  ))
)
WHERE "rewardConfig" IS NOT NULL
  AND jsonb_typeof("rewardConfig") = 'object'
  AND jsonb_typeof("rewardConfig"->'solver') = 'object';

ALTER TABLE "Bug" DROP COLUMN IF EXISTS "severity";
ALTER TABLE "IssueConfirmation" DROP COLUMN IF EXISTS "severity";
ALTER TABLE "IssueConfirmation" DROP COLUMN IF EXISTS "previousSeverity";
ALTER TABLE "ApprovalRule" DROP COLUMN IF EXISTS "severity";
-- The startup repair (scripts/sql/ensure-agent-platform.sql) used to recreate
-- the retired IssueValidation table with severity columns.
ALTER TABLE IF EXISTS "IssueValidation" DROP COLUMN IF EXISTS "severity";
ALTER TABLE IF EXISTS "IssueValidation" DROP COLUMN IF EXISTS "previousSeverity";

DROP TYPE IF EXISTS "Severity";
