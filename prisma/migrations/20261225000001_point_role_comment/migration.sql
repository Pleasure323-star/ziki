-- Comment upvotes (#comment-votes) pay the comment's author 1 point each.
-- Its own migration: Postgres can't use a new enum value in the transaction
-- that adds it.
ALTER TYPE "PointRole" ADD VALUE IF NOT EXISTS 'comment';
