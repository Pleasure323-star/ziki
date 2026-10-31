import { z } from "zod";
import type { Prisma, PrismaClient, Status } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertKeyProject, type AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { audit } from "@/lib/agents/audit";
import { IssueApiError } from "@/lib/agent-api/errors";
import { publish } from "@/lib/agent-api/events";
import { entryDescription, entrySummary } from "@/lib/agent-api/entry-fields";
import { isThresholdOnly, thresholdDecision, voteWeight, type ThresholdDecision } from "@/lib/governance";
import { statusChangedSummary, unboostedSummary } from "@/lib/activity-log";
import { isDone } from "@/lib/issue-state";
import { parseIssueRef, resolveIssueRef } from "@/lib/issue-ref";
import { workflowFor } from "@/lib/workflow";

/**
 * Close suggestions (#close-superseded). Any agent that notices an issue is
 * superseded (another issue or change covers it) suggests closing it, with a
 * comment saying why: one suggestion per person per issue, a manager (or
 * merger) agent's counting the project's `managerVoteWeight`. In a
 * `manager`-governed project, reaching the project's `closeThreshold` does not
 * close the issue: it goes into the managers' queue (the `close_issue` work
 * item), and a manager agent closes it with that reason. In a threshold-only
 * project the suggestion that reaches it closes the issue (#vote-governance).
 */
type Db = PrismaClient | Prisma.TransactionClient;

export const CLOSE_REASONS = ["superseded"] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

export const closeSuggestionSchema = z
  .object({ reason: z.enum(CLOSE_REASONS), summary: entrySummary, description: entryDescription.optional() })
  .strict();

export const closeIssueSchema = z.object({ reason: z.enum(CLOSE_REASONS), summary: entrySummary }).strict();

/** The issue in the agent's project, not deleted; 404 otherwise. */
async function issueInProject(agent: AgentContext, projectId: string, issueRef: string) {
  const resolved = await resolveIssueRef(prisma, parseIssueRef(issueRef), { tenantId: agent.tenantId });
  const bug = resolved && await prisma.bug.findFirst({
    where: { id: resolved.id, tenantId: agent.tenantId, projectId, isDeleted: false },
    select: { id: true, number: true },
  });
  if (!bug) throw new IssueApiError(404, "Issue not found in this project.");
  return bug;
}

/** Locks the issue row and reads its status again, inside the transaction. */
async function lockedIssue(tx: Prisma.TransactionClient, bugId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${bugId} FOR UPDATE`;
  const bug = await tx.bug.findUnique({ where: { id: bugId }, select: { status: true, isDeleted: true, isBoosted: true } });
  if (!bug || bug.isDeleted) throw new IssueApiError(404, "Issue not found in this project.");
  if (isDone(bug.status)) {
    const message = `This issue is already ${bug.status === "resolved" ? "live" : "closed"}.`;
    throw new IssueApiError(409, message, { error: "already_closed", message });
  }
  return bug;
}

/** The suggestions' votes for one reason on an issue, added up. */
export async function closeTally(bugId: string, reason: CloseReason, db: Db = prisma): Promise<number> {
  const total = await db.closeSuggestion.aggregate({ where: { bugId, reason }, _sum: { votes: true } });
  return total._sum.votes ?? 0;
}

/**
 * `POST /api/v1/issues/{id}/close-suggestions` (#close-superseded): suggest
 * closing the issue, with a summary (at most two sentences) and an optional
 * description saying why. Refused on a closed or live issue (409
 * already_closed). A newer suggestion from the same person replaces theirs.
 */
export async function suggestClose(agent: AgentContext, projectId: string, issueRef: string, input: z.infer<typeof closeSuggestionSchema>) {
  requireLevel(agent, "working");
  assertKeyProject(agent, projectId);
  const bug = await issueInProject(agent, projectId, issueRef);
  const workflow = await workflowFor(projectId);
  const { closeThreshold } = workflow;
  const weight = voteWeight(agent.level, workflow.managerVoteWeight);

  const result = await prisma.$transaction(async (tx) => {
    const fresh = await lockedIssue(tx, bug.id);
    const fields = { reason: input.reason, votes: weight, summary: input.summary, description: input.description ?? null, agentId: agent.agentId };
    // One suggestion per person, at the highest weight any of their agents cast.
    const earlier = await tx.closeSuggestion.findUnique({
      where: { bugId_onBehalfOfUserId: { bugId: bug.id, onBehalfOfUserId: agent.ownerId } },
      select: { votes: true },
    });
    await tx.closeSuggestion.upsert({
      where: { bugId_onBehalfOfUserId: { bugId: bug.id, onBehalfOfUserId: agent.ownerId } },
      update: { ...fields, votes: Math.max(weight, earlier?.votes ?? 0) },
      create: { bugId: bug.id, onBehalfOfUserId: agent.ownerId, ...fields },
    });
    const votes = await closeTally(bug.id, input.reason, tx);
    await publish(tx, {
      tenantId: agent.tenantId,
      type: "issue.close_suggested",
      actorAgentId: agent.agentId,
      bugId: bug.id,
      projectId,
      payload: { issueId: bug.id, issueNumber: bug.number, reason: input.reason, votes, threshold: closeThreshold },
    });
    const reached = votes >= closeThreshold;
    // Threshold-only (#vote-governance): the suggestion that reaches the threshold closes it.
    if (reached && isThresholdOnly(workflow)) {
      const decision = thresholdDecision({ userId: agent.ownerId, agentId: agent.agentId }, votes, closeThreshold);
      const closed = await closeInTransaction(tx, agent, projectId, bug, fresh, { reason: input.reason, note: input.summary, votes, threshold: closeThreshold, decision });
      return { issueId: bug.id, issueNumber: bug.number, reason: input.reason, votes, threshold: closeThreshold, queued: false, closed: true, releasedClaimIds: closed.releasedClaimIds };
    }
    return { issueId: bug.id, issueNumber: bug.number, reason: input.reason, votes, threshold: closeThreshold, queued: reached, closed: false, releasedClaimIds: [] as string[] };
  });
  await audit(agent, "issue.close_suggested", `issue:${bug.id}`, { reason: result.reason, votes: result.votes, queued: result.queued, closed: result.closed }, { bugId: bug.id });
  if (result.closed) {
    await audit(
      agent,
      "issue.closed",
      `issue:${bug.id}`,
      { reason: result.reason, votes: result.votes, threshold: result.threshold, via: "threshold", releasedClaimIds: result.releasedClaimIds },
      { bugId: bug.id },
    );
  }
  return result;
}

/**
 * Closes the locked issue with `reason`, in the caller's transaction: releases
 * any live claim (reason `closed`), records the status change and publishes
 * `issue.closed`. A manager's close and, in a threshold-only project, the
 * suggestion that reaches the threshold (`decision`) both end here.
 */
async function closeInTransaction(
  tx: Prisma.TransactionClient,
  agent: AgentContext,
  projectId: string,
  bug: { id: string; number: number },
  fresh: { status: Status; isBoosted: boolean },
  input: { reason: CloseReason; note: string; votes: number; threshold: number; decision?: ThresholdDecision },
) {
  const { reason, votes } = input;
  const claims = await tx.issueClaim.findMany({
    where: { bugId: bug.id, status: { in: ["offered", "active"] }, releasedAt: null },
    select: { id: true, agentId: true, beneficiaryUserId: true },
  });
  const now = new Date();
  if (claims.length) {
    await tx.issueClaim.updateMany({
      where: { id: { in: claims.map((claim) => claim.id) } },
      data: { status: "released", releasedAt: now, releaseReason: "closed" },
    });
  }
  await tx.bug.update({
    where: { id: bug.id },
    data: {
      status: "closed",
      closeReason: reason,
      // A finished issue shouldn't stay pinned above open work (#256).
      ...(fresh.isBoosted ? { isBoosted: false, boostedAt: null } : {}),
    },
  });
  await tx.bugActivity.create({
    data: {
      bugId: bug.id,
      actorId: agent.ownerId,
      type: "status_changed",
      summary: statusChangedSummary(fresh.status, "closed"),
      metadata: {
        field: "status", from: fresh.status, to: "closed", via: reason, votes,
        agentId: agent.agentId, agentName: agent.name, note: input.note,
        // Who cast the deciding vote is the actor above; this says no manager closed it.
        ...(input.decision ? { decidedBy: input.decision.via, threshold: input.threshold } : {}),
      },
    },
  });
  if (fresh.isBoosted) {
    await tx.bugActivity.create({
      data: { bugId: bug.id, actorId: agent.ownerId, type: "unboosted", summary: unboostedSummary(), metadata: { field: "isBoosted", to: "false" } },
    });
  }
  for (const claim of claims) {
    await publish(tx, {
      tenantId: agent.tenantId,
      type: "claim.released",
      actorAgentId: claim.agentId,
      bugId: bug.id,
      projectId,
      payload: { claimId: claim.id, issueId: bug.id, projectId, beneficiaryUserId: claim.beneficiaryUserId, reason: "closed" },
    });
  }
  await publish(tx, {
    tenantId: agent.tenantId,
    type: "issue.closed",
    actorAgentId: agent.agentId,
    bugId: bug.id,
    projectId,
    payload: {
      issueId: bug.id, issueNumber: bug.number, from: fresh.status, reason, summary: input.note, votes, threshold: input.threshold,
      ...(input.decision ?? {}),
    },
  });
  return { releasedClaimIds: claims.map((claim) => claim.id) };
}

/**
 * `POST /api/v1/issues/{id}/close` (#close-superseded), manager level: close
 * the issue as superseded once its suggestions reach `closeThreshold` (409
 * below_threshold before that). In a threshold-only project the suggestion that
 * reaches the threshold has closed it already; this remains for a threshold
 * lowered after the votes were cast. Releases any live claim (reason `closed`),
 * records the status change with the manager's summary as its note, and
 * publishes `issue.closed`.
 */
export async function closeIssueAsSuperseded(agent: AgentContext, projectId: string, issueRef: string, input: { summary: string }) {
  requireLevel(agent, "manager");
  assertKeyProject(agent, projectId);
  const bug = await issueInProject(agent, projectId, issueRef);
  const { closeThreshold } = await workflowFor(projectId);
  const reason: CloseReason = "superseded";

  const result = await prisma.$transaction(async (tx) => {
    const fresh = await lockedIssue(tx, bug.id);
    const votes = await closeTally(bug.id, reason, tx);
    if (votes < closeThreshold) {
      const message = `${votes} of ${closeThreshold} votes suggest closing this issue as superseded; it can be closed once they reach the threshold.`;
      throw new IssueApiError(409, message, { error: "below_threshold", message, votes, threshold: closeThreshold });
    }
    const closed = await closeInTransaction(tx, agent, projectId, bug, fresh, { reason, note: input.summary, votes, threshold: closeThreshold });
    return {
      issueId: bug.id,
      issueNumber: bug.number,
      status: "closed" as const,
      closeReason: reason,
      votes,
      threshold: closeThreshold,
      releasedClaimIds: closed.releasedClaimIds,
    };
  });
  await audit(agent, "issue.closed", `issue:${bug.id}`, { reason, votes: result.votes, releasedClaimIds: result.releasedClaimIds }, { bugId: bug.id });
  return result;
}

export type CloseSuggestionView = {
  id: string;
  reason: string;
  votes: number;
  summary: string;
  description: string | null;
  onBehalfOfUserId: string;
  by: string;
  agentName: string | null;
  updatedAt: Date;
};

export type CloseSuggestionsData = {
  entries: CloseSuggestionView[];
  /** The votes to close it as superseded, and the project's closeThreshold. */
  votes: number;
  threshold: number;
  /** True when the suggestion that reaches the threshold closes the issue (#vote-governance). */
  thresholdOnly: boolean;
  managerVoteWeight: number;
};

/** An issue's close suggestions for its page, oldest first, with the tally. Null for an unknown issue. */
export async function closeSuggestionsFor(bugId: string): Promise<CloseSuggestionsData | null> {
  const bug = await prisma.bug.findUnique({ where: { id: bugId }, select: { projectId: true } });
  if (!bug) return null;
  const [rows, workflow] = await Promise.all([
    prisma.closeSuggestion.findMany({
      where: { bugId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true, reason: true, votes: true, summary: true, description: true, onBehalfOfUserId: true, updatedAt: true,
        onBehalfOf: { select: { name: true } },
        agent: { select: { name: true } },
      },
    }),
    workflowFor(bug.projectId),
  ]);
  const entries = rows.map((row) => ({
    id: row.id,
    reason: row.reason,
    votes: row.votes,
    summary: row.summary,
    description: row.description,
    onBehalfOfUserId: row.onBehalfOfUserId,
    by: row.onBehalfOf.name,
    agentName: row.agent?.name ?? null,
    updatedAt: row.updatedAt,
  }));
  const votes = entries.filter((entry) => entry.reason === "superseded").reduce((sum, entry) => sum + entry.votes, 0);
  return { entries, votes, threshold: workflow.closeThreshold, thresholdOnly: isThresholdOnly(workflow), managerVoteWeight: workflow.managerVoteWeight };
}
