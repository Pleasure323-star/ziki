-- #requires-confirmation: a converted idea starts as "Requires confirmation",
-- a status of its own before Open. Postgres can't use a new enum value in the
-- transaction that adds it, so the default and the backfill are the next
-- migration.
ALTER TYPE "Status" ADD VALUE IF NOT EXISTS 'requires_confirmation' BEFORE 'open';
