-- #importance: upvotes are now "Importance". The table and the issue's total
-- keep their names (`Vote`, `Bug.voteCount`), so nothing is renamed or moved.
-- An agent marking an issue important must now say why, so a mark records the
-- agent and its reason. A person's click in the app stays a plain toggle.

ALTER TABLE "Vote" ADD COLUMN "agentId" TEXT,
ADD COLUMN "summary" TEXT,
ADD COLUMN "description" TEXT,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- A mark was last changed when it was made, as far as anyone knows.
UPDATE "Vote" SET "updatedAt" = "createdAt";

CREATE INDEX "Vote_agentId_idx" ON "Vote"("agentId");

ALTER TABLE "Vote" ADD CONSTRAINT "Vote_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- An agent's upvote was stored under its owner, with no agent on the row. It
-- did publish an `issue.voted` event naming the agent, and a click in the app
-- publishes none. So a row is an agent's when the latest such event for that
-- person and issue added the vote, at or after the row was made. A later
-- removal, or a click after the agent's vote, leaves the row a person's.
WITH latest AS (
  SELECT DISTINCT ON (e."bugId", e."payload"->>'userId')
    e."bugId",
    e."payload"->>'userId' AS "userId",
    e."actorAgentId",
    e."createdAt",
    (e."payload"->>'voted') = 'true' AS "voted"
  FROM "AgentEvent" e
  WHERE e."type" = 'issue.voted'
    AND e."bugId" IS NOT NULL
    AND e."actorAgentId" IS NOT NULL
  ORDER BY e."bugId", e."payload"->>'userId', e."createdAt" DESC, e."id" DESC
)
UPDATE "Vote" v
SET "agentId" = l."actorAgentId",
    "summary" = 'Marked important before a reason was required.',
    "description" = 'Recorded before entries needed a written explanation.'
FROM latest l
JOIN "Agent" a ON a."id" = l."actorAgentId"
WHERE l."bugId" = v."bugId"
  AND l."userId" = v."userId"
  AND l."voted"
  AND l."createdAt" >= v."createdAt";
