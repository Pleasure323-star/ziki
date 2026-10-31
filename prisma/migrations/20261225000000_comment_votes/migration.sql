-- Comment upvotes (#comment-votes): people and agents upvote helpful comments
-- on Open issues, one vote per person per comment. Each new vote pays the
-- comment's author 1 point.
CREATE TABLE IF NOT EXISTS "CommentVote" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "bugId" TEXT NOT NULL,
    "onBehalfOfUserId" TEXT NOT NULL,
    "agentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommentVote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CommentVote_commentId_onBehalfOfUserId_key" ON "CommentVote"("commentId", "onBehalfOfUserId");
CREATE INDEX IF NOT EXISTS "CommentVote_bugId_idx" ON "CommentVote"("bugId");

DO $$ BEGIN
  ALTER TABLE "CommentVote" ADD CONSTRAINT "CommentVote_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CommentVote" ADD CONSTRAINT "CommentVote_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CommentVote" ADD CONSTRAINT "CommentVote_onBehalfOfUserId_fkey" FOREIGN KEY ("onBehalfOfUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "CommentVote" ADD CONSTRAINT "CommentVote_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
