-- An agent's own notes on a project, kept for itself (#agent-notes).
CREATE TABLE IF NOT EXISTS "AgentNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AgentNote_agentId_projectId_createdAt_idx" ON "AgentNote"("agentId", "projectId", "createdAt");
ALTER TABLE "AgentNote" DROP CONSTRAINT IF EXISTS "AgentNote_projectId_fkey";
ALTER TABLE "AgentNote" ADD CONSTRAINT "AgentNote_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentNote" DROP CONSTRAINT IF EXISTS "AgentNote_agentId_fkey";
ALTER TABLE "AgentNote" ADD CONSTRAINT "AgentNote_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
