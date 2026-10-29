import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { workflowFor } from "@/lib/workflow";
import { openIssueConfirmations, type ConfirmationState } from "@/lib/issue-stage";

export type ClaimableIssue = {
  id: string;
  number: number;
  title: string;
  projectId: string;
  voteCount: number;
  severity: string;
  createdAt: Date;
};

/**
 * Confirmed issues free to be claimed or bid on: no active claim and no live
 * offer. Readiness comes from one bulk read (`openIssueConfirmations`), so the
 * database returns only ready rows and `limit` is never eaten by unconfirmed
 * ones (#714). Pass `confirmations` to reuse a read the caller already made.
 */
export async function findClaimableIssues(
  agent: AgentContext,
  projectId: string,
  limit = 50,
  confirmations?: Map<string, ConfirmationState>,
): Promise<ClaimableIssue[]> {
  requireLevel(agent, "working");
  const workflow = await workflowFor(projectId);
  const offerCutoff = new Date(Date.now() - workflow.offerWindowSeconds * 1000);
  const stages = confirmations ?? await openIssueConfirmations(prisma, { tenantId: agent.tenantId, projectId });
  const readyIds = [...stages].filter(([, confirmation]) => confirmation.stage === "ready").map(([id]) => id);
  if (readyIds.length === 0) return [];

  return prisma.bug.findMany({
    where: {
      id: { in: readyIds },
      tenantId: agent.tenantId,
      projectId,
      claims: {
        none: {
          releasedAt: null,
          OR: [
            { status: "active" },
            { status: "offered", offeredAt: { gt: offerCutoff } },
          ],
        },
      },
    },
    take: limit,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      number: true,
      title: true,
      projectId: true,
      voteCount: true,
      severity: true,
      createdAt: true,
    },
  });
}
