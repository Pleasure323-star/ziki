import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { confirmedIssueIds } from "@/lib/issue-stage";
import { countedMergeVerdicts, deliveredClaim } from "@/lib/agent-api/merge-verdicts";
import { reviewerConflict } from "@/lib/agents/independence";
import { workflowFor } from "@/lib/workflow";

/** The two merge queues: tested fixes waiting for a manager's accept, and accepted ones waiting to merge. */
export type MergeQueueStatus = "done" | "ready_to_merge";

export type ReadyToMergeIssue = {
  id: string;
  number: number;
  title: string;
  projectId: string;
  pullRequestUrl: string;
  pullRequestHeadSha: string | null;
  status: MergeQueueStatus;
  claim: {
    agentId: string;
    beneficiaryUserId: string;
  } | null;
  verdictsCount: number;
  createdAt: Date;
};

/**
 * Confirmed issues with a linked pull request at one merge step, that this
 * agent is independent of: `done` (tested, waiting for a manager's accept,
 * which also needs enough independent good-to-merge verdicts on the linked
 * pull request) or `ready_to_merge` (accepted, waiting for the merge, blocked
 * and failed merges included).
 */
export async function findReadyToMergeIssues(
  agent: AgentContext,
  projectId: string,
  limit: number,
  status: MergeQueueStatus,
): Promise<ReadyToMergeIssue[]> {
  requireLevel(agent, "manager");
  const { verdictsNeeded } = await workflowFor(projectId);

  // Confirmation from one bulk read, not one isConfirmed() per row (#714).
  const confirmed = await confirmedIssueIds(prisma, {
    tenantId: agent.tenantId,
    projectId,
    status,
    pullRequestUrl: { not: null },
  });
  if (confirmed.size === 0) return [];

  // Fixes in review are few, so read them all and filter before limiting:
  // taking `limit` rows first and filtering after could return a short page.
  const candidates = await prisma.bug.findMany({
    where: {
      id: { in: [...confirmed] },
      tenantId: agent.tenantId,
      projectId,
      isDeleted: false,
      status,
      pullRequestUrl: { not: null },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      number: true,
      title: true,
      projectId: true,
      pullRequestUrl: true,
      pullRequestHeadSha: true,
      reporterId: true,
      beneficiaryUserId: true,
      assigneeId: true,
      createdByAgentId: true,
      createdByAgent: { select: { ownerUserId: true } },
      createdAt: true,
      claims: {
        select: {
          status: true,
          claimedAt: true,
          releasedAt: true,
          agentId: true,
          beneficiaryUserId: true,
          dispatcherUserId: true,
          agent: { select: { ownerUserId: true } },
        },
      },
      testVerdicts: {
        where: { goodToMerge: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          headSha: true,
          onBehalfOfUserId: true,
          pullRequestUrl: true,
          agent: { select: { id: true, ownerUserId: true } },
        },
      },
    },
  });

  const ready: ReadyToMergeIssue[] = [];
  for (const bug of candidates) {
    if (ready.length >= limit) break;

    const claim = deliveredClaim(bug);
    // The same verdict rule as the merge gate (merge.ts), on the linked PR only.
    const onLinkedPr = bug.testVerdicts.filter((verdict) => verdict.pullRequestUrl === bug.pullRequestUrl);
    const { reviewers } = countedMergeVerdicts(onLinkedPr, claim, bug);

    if (status === "done" && reviewers.length < verdictsNeeded) continue;

    if (reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, bug)) continue;

    ready.push({
      id: bug.id,
      number: bug.number,
      title: bug.title,
      projectId: bug.projectId,
      pullRequestUrl: bug.pullRequestUrl!,
      pullRequestHeadSha: bug.pullRequestHeadSha,
      status,
      claim: claim ? { agentId: claim.agentId, beneficiaryUserId: claim.beneficiaryUserId } : null,
      verdictsCount: reviewers.length,
      createdAt: bug.createdAt,
    });
  }

  return ready;
}
