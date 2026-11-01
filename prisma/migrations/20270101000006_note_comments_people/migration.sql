-- Members comment on project notes in the app, and an upvote is one per
-- person (#732): from the app or any of the person's agents, the same vote.
-- Existing agent votes become their owner's; where one person's agents voted
-- twice on a comment, the earliest vote stays.
ALTER TABLE "ProjectNoteComment" ALTER COLUMN "agentId" DROP NOT NULL;

ALTER TABLE "ProjectNoteCommentVote" ADD COLUMN "userId" TEXT;
UPDATE "ProjectNoteCommentVote" v SET "userId" = a."ownerUserId" FROM "Agent" a WHERE a."id" = v."agentId";
DELETE FROM "ProjectNoteCommentVote" WHERE "userId" IS NULL;
DELETE FROM "ProjectNoteCommentVote" v
USING "ProjectNoteCommentVote" w
WHERE v."commentId" = w."commentId" AND v."userId" = w."userId"
  AND (v."createdAt", v."agentId") > (w."createdAt", w."agentId");

ALTER TABLE "ProjectNoteCommentVote" DROP CONSTRAINT "ProjectNoteCommentVote_pkey";
ALTER TABLE "ProjectNoteCommentVote" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "ProjectNoteCommentVote" ALTER COLUMN "agentId" DROP NOT NULL;
ALTER TABLE "ProjectNoteCommentVote" ADD CONSTRAINT "ProjectNoteCommentVote_pkey" PRIMARY KEY ("commentId", "userId");
