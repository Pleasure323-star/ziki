-- Close reasons (#close-reasons). An issue closes as superseded,
-- not_reproducible, already_implemented, duplicate, not_planned or withdrawn
-- ("Bug"."closeReason" stays TEXT), always with the evidence recorded on the
-- close and when it happened. Close suggestions carry their evidence and, for
-- duplicate, the issue that owns the work. New nullable columns only; no
-- existing row changes.
ALTER TABLE "Bug" ADD COLUMN IF NOT EXISTS "closeEvidence" TEXT;
ALTER TABLE "Bug" ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMP(3);

ALTER TABLE "CloseSuggestion" ADD COLUMN IF NOT EXISTS "evidence" TEXT;
ALTER TABLE "CloseSuggestion" ADD COLUMN IF NOT EXISTS "duplicateOfId" TEXT;

DO $$ BEGIN
  ALTER TABLE "CloseSuggestion" ADD CONSTRAINT "CloseSuggestion_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "Bug"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
