-- Merge's error substatus is just Error: every state where the pull request can't go in
-- (closed unmerged, missing, conflicting, failing checks). A rename keeps every row.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'Substatus' AND e.enumlabel = 'merge_error') THEN
    ALTER TYPE "Substatus" RENAME VALUE 'merge_error' TO 'error';
  END IF;
END $$;
