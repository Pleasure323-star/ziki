-- Main statuses and substatuses (#substatus). An issue keeps one main status
-- (the issue list's tabs) and gains a substatus, the step within it:
--   Open: requires_confirmation, open
--   In progress: in_progress
--   Done: requires_review (was delivered), accepted (was done)
--   Merge: ready_to_merge, merge_error
--   Live (resolved): on_dev, on_staging, on_prod (live issues so far are on prod)
--   Closed: closed
-- The Status enum is rebuilt with the main values only; old values map onto
-- them. Runs in one transaction, so a failure leaves the old shape intact.

CREATE TYPE "Substatus" AS ENUM (
  'requires_confirmation', 'open', 'in_progress', 'requires_review', 'accepted',
  'ready_to_merge', 'merge_error', 'on_dev', 'on_staging', 'on_prod', 'closed'
);

ALTER TABLE "Bug" ADD COLUMN "substatus" "Substatus" NOT NULL DEFAULT 'requires_confirmation';

UPDATE "Bug" SET "substatus" = (CASE "status"::text
  WHEN 'requires_confirmation' THEN 'requires_confirmation'
  WHEN 'open' THEN 'open'
  WHEN 'in_progress' THEN 'in_progress'
  WHEN 'delivered' THEN 'requires_review'
  WHEN 'done' THEN 'accepted'
  WHEN 'ready_to_merge' THEN 'ready_to_merge'
  WHEN 'resolved' THEN 'on_prod'
  ELSE 'closed'
END)::"Substatus";

CREATE TYPE "Status_new" AS ENUM ('open', 'in_progress', 'done', 'merge', 'resolved', 'closed');
ALTER TABLE "Bug" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Bug" ALTER COLUMN "status" TYPE "Status_new" USING (CASE "status"::text
  WHEN 'requires_confirmation' THEN 'open'
  WHEN 'delivered' THEN 'done'
  WHEN 'ready_to_merge' THEN 'merge'
  ELSE "status"::text
END)::"Status_new";
DROP TYPE "Status";
ALTER TYPE "Status_new" RENAME TO "Status";
ALTER TABLE "Bug" ALTER COLUMN "status" SET DEFAULT 'open';

CREATE INDEX "Bug_tenantId_projectId_substatus_idx" ON "Bug"("tenantId", "projectId", "substatus");
