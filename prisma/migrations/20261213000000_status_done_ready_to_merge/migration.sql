-- One status per issue: Done and Ready to merge become statuses of their own,
-- in place of Bug.reviewStatus. A new enum value can't be used in the
-- transaction that adds it, so the backfill is the next migration.
ALTER TYPE "Status" ADD VALUE IF NOT EXISTS 'done' BEFORE 'resolved';
ALTER TYPE "Status" ADD VALUE IF NOT EXISTS 'ready_to_merge' BEFORE 'resolved';