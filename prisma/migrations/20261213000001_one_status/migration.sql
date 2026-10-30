-- One status per issue. Bug.reviewStatus was a second status beside
-- Bug.status; every issue moves onto the one status, then the column goes.
-- An issue keeps the place its fix reached even if the agent's claim was
-- released since (a released claim no longer sends a delivered fix back to Open).
--
--   reviewStatus tested                                   -> done
--   reviewStatus ready_to_merge, merge_blocked, merge_failed -> ready_to_merge
--   reviewStatus merged                                   -> resolved (Live)
--   a linked pull request otherwise (submitted, rejected) -> in_progress
-- Issues that require confirmation, or are resolved or closed, keep their status.
-- Safe to run again (Prisma does not wrap a migration in one transaction): the
-- moves run only while the column is still there, and each moves only what
-- still needs moving.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'Bug' AND column_name = 'reviewStatus') THEN
    UPDATE "Bug" SET "status" = 'done'
    WHERE "status" IN ('open', 'in_progress') AND "reviewStatus" = 'tested';

    UPDATE "Bug" SET "status" = 'ready_to_merge'
    WHERE "status" IN ('open', 'in_progress') AND "reviewStatus" IN ('ready_to_merge', 'merge_blocked', 'merge_failed');

    UPDATE "Bug" SET "status" = 'resolved'
    WHERE "status" IN ('open', 'in_progress') AND "reviewStatus" = 'merged';
  END IF;
END $$;

UPDATE "Bug" SET "status" = 'in_progress'
WHERE "status" = 'open' AND "pullRequestUrl" IS NOT NULL;

ALTER TABLE "Bug" DROP COLUMN IF EXISTS "reviewStatus";
