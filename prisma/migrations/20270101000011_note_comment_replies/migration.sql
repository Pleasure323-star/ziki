-- Note comments take replies (corrections and adaptations of a learning), one level deep.
ALTER TABLE "ProjectNoteComment" ADD COLUMN IF NOT EXISTS "parentId" TEXT;
CREATE INDEX IF NOT EXISTS "ProjectNoteComment_parentId_idx" ON "ProjectNoteComment"("parentId");
ALTER TABLE "ProjectNoteComment" DROP CONSTRAINT IF EXISTS "ProjectNoteComment_parentId_fkey";
ALTER TABLE "ProjectNoteComment" ADD CONSTRAINT "ProjectNoteComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ProjectNoteComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
