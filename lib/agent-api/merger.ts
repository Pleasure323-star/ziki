import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { confirmedIssueIds } from "@/lib/issue-stage";
import { countedMergeVerdicts } from "@/lib/agent-api/merge-verdicts";
import { reviewerConflict } from "@/lib/agents/independence";
import { workflowFor } from "@/lib/workflow";
import { MERGE_BLOCKED, MERGE_FAILED } from "@/lib/merge-status";

/** Still waiting on the admin merge: ready, or blocked or failed and able to try again. */
const AWAITING_MERGE = ["ready_to_merge", MERGE_BLOCKED, MERGE_FAILED];

export type ReadyToMergeIssue = {
  id: string;
  number: number;
  title: string;
  projectId: string;
  pullRequestUrl: string;
  pullRequestHeadSha: string | null;
  reviewStatus: string | null;
  claim: {
    agentId: string;
    beneficiaryUserId: string;
  } | null;
  verdictsCount: number;
  createdAt: Date;
};

/**
 * Scan for issues ready to be merged: confirmed, active claim, linked PR,
 * and sufficient independent goodToMerge test verdicts, with merger independence.
 */
export async function findReadyToMergeIssues(
  agent: AgentContext,
  projectId: string,
  limit = 50,
  reviewStatusFilter?: string | null,
): Promise<ReadyToMergeIssue[]> {
  requireLevel(agent, "manager");
  const { verdictsNeeded } = await workflowFor(projectId);

  // Prisma can't match null inside `in`, so "submitted, tested or not reviewed yet" is an OR.
  let reviewStatusCondition: Prisma.BugWhereInput;
  if (reviewStatusFilter === "ready_to_merge") {
    reviewStatusCondition = { reviewStatus: { in: AWAITING_MERGE } };
  } else if (reviewStatusFilter === "submitted") {
    reviewStatusCondition = { OR: [{ reviewStatus: { in: ["submitted", "tested"] } }, { reviewStatus: null }] };
  } else if (reviewStatusFilter === "all") {
    reviewStatusCondition = { reviewStatus: { not: "rejected" } };
  } else if (agent.level === "merger") {
    reviewStatusCondition = { reviewStatus: { in: AWAITING_MERGE } };
  } else {
    reviewStatusCondition = { reviewStatus: { not: "rejected" } };
  }

  // Confirmation from one bulk read, not one isConfirmed() per row (#714).
  const confirmed = await confirmedIssueIds(prisma, {
    tenantId: agent.tenantId,
    projectId,
    status: { in: ["open", "in_progress"] },
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
      status: { in: ["open", "in_progress"] },
      pullRequestUrl: { not: null },
      AND: [reviewStatusCondition],
      OR: [
        { reviewStatus: { in: AWAITING_MERGE } },
        {
          claims: {
            some: {
              status: "active",
              releasedAt: null,
            },
          },
        },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      number: true,
      title: true,
      projectId: true,
      pullRequestUrl: true,
      pullRequestHeadSha: true,
      reviewStatus: true,
      reporterId: true,
      beneficiaryUserId: true,
      assigneeId: true,
      createdByAgentId: true,
      createdByAgent: { select: { ownerUserId: true } },
      createdAt: true,
      claims: {
        select: {
          status: true,
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

    const claim = bug.claims.find((c) => c.status === "active" && !c.releasedAt) ?? null;
    // The same verdict rule as the merge gate (merge.ts), on the linked PR only.
    const onLinkedPr = bug.testVerdicts.filter((verdict) => verdict.pullRequestUrl === bug.pullRequestUrl);
    const { reviewers } = countedMergeVerdicts(onLinkedPr, claim, bug);

    if (!AWAITING_MERGE.includes(bug.reviewStatus ?? "") && reviewers.length < verdictsNeeded) continue;

    if (reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, bug)) continue;

    ready.push({
      id: bug.id,
      number: bug.number,
      title: bug.title,
      projectId: bug.projectId,
      pullRequestUrl: bug.pullRequestUrl!,
      pullRequestHeadSha: bug.pullRequestHeadSha,
      reviewStatus: bug.reviewStatus,
      claim: claim ? { agentId: claim.agentId, beneficiaryUserId: claim.beneficiaryUserId } : null,
      verdictsCount: reviewers.length,
      createdAt: bug.createdAt,
    });
  }

  return ready;
}
