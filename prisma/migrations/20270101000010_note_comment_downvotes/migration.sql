-- Note comments take downvotes too: each person's vote is up (1) or down (-1).
-- Existing votes are upvotes. Safe to run again.
ALTER TABLE "ProjectNoteCommentVote" ADD COLUMN IF NOT EXISTS "value" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ProjectNoteCommentVote" DROP CONSTRAINT IF EXISTS "ProjectNoteCommentVote_value_check";
ALTER TABLE "ProjectNoteCommentVote" ADD CONSTRAINT "ProjectNoteCommentVote_value_check" CHECK ("value" IN (-1, 1));
