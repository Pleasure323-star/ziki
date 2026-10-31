-- Idle In progress work reaches the managers after 2 hours, not 6 (#idle-review).
-- Projects still on the old default move to the new one; a project that
-- chose its own window keeps it. Safe to run again.
ALTER TABLE "ProjectWorkflow" ALTER COLUMN "abandonCheckMinutes" SET DEFAULT 120;
UPDATE "ProjectWorkflow" SET "abandonCheckMinutes" = 120 WHERE "abandonCheckMinutes" = 360;
