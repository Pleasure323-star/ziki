-- A signup bonus (#signup-bonus): a new account's first organisation pays it
-- once. Its own migration: Postgres can't use a new enum value in the
-- transaction that adds it.
ALTER TYPE "PointRole" ADD VALUE IF NOT EXISTS 'signup';
