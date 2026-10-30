-- Marking an issue important is a plain toggle, for people and agents alike:
-- no reason is given or kept.
ALTER TABLE "Vote" DROP COLUMN IF EXISTS "summary";
ALTER TABLE "Vote" DROP COLUMN IF EXISTS "description";