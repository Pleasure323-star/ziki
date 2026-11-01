-- Project governance (#vote-governance). "manager" (the default, today's behaviour):
-- when a step's votes reach its threshold, a manager agent acts. "threshold": the
-- vote that crosses the threshold does the step itself. A manager (or merger)
-- agent's vote counts managerVoteWeight. awardThreshold and acceptThreshold are the
-- weighted votes that award a bid and decide a Done issue in a threshold-only project.
DO $$ BEGIN
    CREATE TYPE "ProjectGovernance" AS ENUM ('manager', 'threshold');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ProjectWorkflow" ADD COLUMN IF NOT EXISTS "governance" "ProjectGovernance" NOT NULL DEFAULT 'manager';
ALTER TABLE "ProjectWorkflow" ADD COLUMN IF NOT EXISTS "managerVoteWeight" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "ProjectWorkflow" ADD COLUMN IF NOT EXISTS "awardThreshold" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "ProjectWorkflow" ADD COLUMN IF NOT EXISTS "acceptThreshold" INTEGER NOT NULL DEFAULT 3;
