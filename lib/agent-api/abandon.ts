import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertKeyProject, type AgentContext } from "@/lib/agents/require-agent";
import { hasLevel, requireLevel } from "@/lib/agents/levels";
import { audit } from "@/lib/agents/audit";
import { IssueApiError } from "@/lib/agent-api/errors";
import { publish } from "@/lib/agent-api/events";
import { entrySummary } from "@/lib/agent-api/entry-fields";
import { statusChangedSummary } from "@/lib/activity-log";
import { parseIssueRef, resolveIssueRef } from "@/lib/issue-ref";
import { workflowFor } from "@/lib/workflow";

/**
 * Sense checks on stale in-progress work (#abandon). When work has had no
 * update for the project's `abandonCheckMinutes` (6 hours by default), every
 * other agent's work feed asks it to check. Each person, through their agent,
 * may vote that it is abandoned: one vote per person per claim, a manager (or
 * merger) agent's counting 3. Once the claim's votes reach `abandonThreshold`
 * the claim is released, its award no longer stands, and the issue goes back
 * to Open with no assignee.
 */
type Db = PrismaClient | Prisma.TransactionClient;

export const MANAGER_ABANDON_VOTES = 3;

export const abandonVoteSchema = z.object({ summary: entrySummary }).strict();

/** The weight of one agent's Abandoned vote. */
export function abandonVoteWeight(level: AgentContext["level"]): number {
  return hasLevel(level, "manager") ? MANAGER_ABANDON_VOTES : 1;
}

/** The last real update on held work: claimed, extended, the issue changed, or a comment. Heartbeats don't count. */
export function lastUpdateAt(dates: (Date | null | undefined)[]): Date | null {
  const times = dates.filter((date): date is Date => date instanceof Date).map((date) => date.getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

export function isSenseCheckDue(lastUpdate: Date | null, abandonCheckMinutes: number, now = Date.now()): boolean {
  return lastUpdate !== null && now - lastUpdate.getTime() >= abandonCheckMinutes * 60_000;
}

/** The active claim on an in-progress issue and when it last saw an update. */
async function heldWork(db: Db, bugId: string) {
  const claim = await db.issueClaim.findFirst({
    where: { bugId, status: "active", releasedAt: null, bug: { status: "in_progress", isDeleted: false } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true, agentId: true, beneficiaryUserId: true, claimedAt: true, extendedAt: true,
      agent: { select: { ownerUserId: true } },
      bug: { select: { updatedAt: true, projectId: true, assigneeId: true } },
    },
  });
  if (!claim) return null;
  const lastComment = await db.comment.findFirst({
    where: { bugId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return { claim, lastUpdate: lastUpdateAt([claim.claimedAt, claim.extendedAt, claim.bug.updatedAt, lastComment?.createdAt]) };
}

/** The Abandoned votes on a claim, added up. */
export async function abandonTally(claimId: string, db: Db = prisma): Promise<{ votes: number; voters: string[] }> {
  const rows = await db.abandonVote.findMany({ where: { claimId }, select: { votes: true, onBehalfOfUserId: true } });
  return { votes: rows.reduce((sum, row) => sum + row.votes, 0), voters: rows.map((row) => row.onBehalfOfUserId) };
}

/** The sense check an issue page shows: due, and the votes so far. Null when nothing is due. */
export async function senseCheck(bugId: string, now = Date.now()) {
  const held = await heldWork(prisma, bugId);
  if (!held) return null;
  const { abandonCheckMinutes, abandonThreshold } = await workflowFor(held.claim.bug.projectId);
  if (!isSenseCheckDue(held.lastUpdate, abandonCheckMinutes, now)) return null;
  const { votes } = await abandonTally(held.claim.id);
  return { claimId: held.claim.id, lastUpdate: held.lastUpdate, votes, threshold: abandonThreshold };
}

/**
 * `POST /api/v1/issues/{id}/abandon-votes` (#abandon): vote that the held work
 * is abandoned. Refused while the sense check is not due (409 not_due), on an
 * issue nobody is working on (409), and for the holder's own owner (403). A
 * newer vote from the same person replaces theirs.
 */
export async function voteAbandoned(agent: AgentContext, projectId: string, issueRef: string, input: z.infer<typeof abandonVoteSchema>) {
  requireLevel(agent, "working");
  assertKeyProject(agent, projectId);
  const resolved = await resolveIssueRef(prisma, parseIssueRef(issueRef), { tenantId: agent.tenantId });
  const bug = resolved && await prisma.bug.findFirst({
    where: { id: resolved.id, tenantId: agent.tenantId, projectId, isDeleted: false },
    select: { id: true, number: true },
  });
  if (!bug) throw new IssueApiError(404, "Issue not found in this project.");
  const workflow = await workflowFor(projectId);
  const weight = abandonVoteWeight(agent.level);

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${bug.id} FOR UPDATE`;
    const held = await heldWork(tx, bug.id);
    if (!held) throw new IssueApiError(409, "Nobody is working on this issue, so there is nothing to check.", { error: "not_in_progress" });
    const { claim } = held;
    if (agent.ownerId === claim.beneficiaryUserId || agent.ownerId === claim.agent.ownerUserId) {
      throw new IssueApiError(403, "This is your owner's own work; another agent checks it.", { error: "own_work" });
    }
    if (!isSenseCheckDue(held.lastUpdate, workflow.abandonCheckMinutes)) {
      const message = `This work was updated less than ${workflow.abandonCheckMinutes} minutes ago; it is not up for a sense check yet.`;
      throw new IssueApiError(409, message, { error: "not_due", message });
    }
    await tx.abandonVote.upsert({
      where: { claimId_onBehalfOfUserId: { claimId: claim.id, onBehalfOfUserId: agent.ownerId } },
      update: { votes: weight, summary: input.summary, agentId: agent.agentId },
      create: { claimId: claim.id, bugId: bug.id, onBehalfOfUserId: agent.ownerId, agentId: agent.agentId, votes: weight, summary: input.summary },
    });
    const { votes } = await abandonTally(claim.id, tx);
    await publish(tx, {
      tenantId: agent.tenantId,
      type: "issue.abandon_voted",
      actorAgentId: agent.agentId,
      bugId: bug.id,
      projectId,
      payload: { issueId: bug.id, issueNumber: bug.number, claimId: claim.id, votes, threshold: workflow.abandonThreshold },
    });
    const abandoned = votes >= workflow.abandonThreshold;
    if (abandoned) {
      const now = new Date();
      await tx.issueClaim.update({ where: { id: claim.id }, data: { status: "released", releasedAt: now, releaseReason: "abandoned" } });
      await tx.bug.update({ where: { id: bug.id }, data: { status: "open", assigneeId: null } });
      await tx.bugActivity.create({
        data: {
          bugId: bug.id,
          actorId: agent.ownerId,
          type: "status_changed",
          summary: statusChangedSummary("in_progress", "open"),
          metadata: { field: "status", from: "in_progress", to: "open", via: "abandoned", votes },
        },
      });
      await publish(tx, {
        tenantId: agent.tenantId,
        type: "claim.released",
        actorAgentId: claim.agentId,
        bugId: bug.id,
        projectId,
        payload: { claimId: claim.id, issueId: bug.id, projectId, beneficiaryUserId: claim.beneficiaryUserId, reason: "abandoned" },
      });
    }
    return { issueId: bug.id, issueNumber: bug.number, claimId: claim.id, votes, threshold: workflow.abandonThreshold, abandoned, status: abandoned ? "open" : "in_progress" };
  });
  await audit(agent, "issue.abandon_voted", `issue:${bug.id}`, { claimId: result.claimId, votes: result.votes, abandoned: result.abandoned }, { bugId: bug.id });
  return result;
}
