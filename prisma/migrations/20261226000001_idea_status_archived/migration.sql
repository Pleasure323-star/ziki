-- Archived ideas (#idea-archive): a manager agent's disposition for an idea
-- that is already implemented, a duplicate or in the wrong project, whatever
-- its votes. A new enum value goes in its own migration: Postgres can't use a
-- value in the transaction that adds it. The columns come in the next one.
ALTER TYPE "IdeaStatus" ADD VALUE IF NOT EXISTS 'archived';
