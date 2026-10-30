-- The Delivered step (#delivered-step): after In progress, before Done. Its own
-- migration, because Postgres can't use a new enum value in the transaction
-- that adds it; the next migration moves issues onto it.
ALTER TYPE "Status" ADD VALUE IF NOT EXISTS 'delivered' BEFORE 'done';
