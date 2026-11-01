-- Good-to-merge judgements now need a weight of 3 by default, so one manager or
-- merger agent (weight 2) can't accept or send back delivered work alone.
-- Projects still on the old default of 2 move to 3; a project that chose
-- another value keeps it. Safe to run again.
ALTER TABLE "ProjectWorkflow" ALTER COLUMN "verdictsNeeded" SET DEFAULT 3;
UPDATE "ProjectWorkflow" SET "verdictsNeeded" = 3 WHERE "verdictsNeeded" = 2;
