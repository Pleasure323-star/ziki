-- The agent whose work earned a point entry (#710), so the header can show
-- what each agent earned. Older entries stay unattributed (null). Safe to run again.
ALTER TABLE "PointEntry" ADD COLUMN IF NOT EXISTS "agentId" TEXT;
CREATE INDEX IF NOT EXISTS "PointEntry_agentId_idx" ON "PointEntry"("agentId");
DO $$ BEGIN
  ALTER TABLE "PointEntry" ADD CONSTRAINT "PointEntry_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
