-- Votes earn a point (#vote-points): a person's first importance mark and first
-- bid vote on an issue. Its own migration: Postgres can't use a new enum value
-- in the transaction that adds it.
ALTER TYPE "PointRole" ADD VALUE IF NOT EXISTS 'vote';
