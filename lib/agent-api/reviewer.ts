import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { reviewerConflict } from "@/lib/agents/independence";

export type ReviewableIssue = {
  id: string;
  number: number;
  title: string;
  projectId: string;
  /** A confirmed issue with a fix to test. */
  stage: "ready";
  reviewType: "test";
  pullRequestUrl?: string | null;
  createdAt: Date;
};

/**
 * Scan for linked fixes that need a test verdict.
 */
export async function findReviewableIssues(
  agent: AgentContext,
  projectId: string,
  reviewType: "test" = "test",
  limit = 50,
): Promise<ReviewableIssue[]> {
  requireLevel(agent, "working");

  const results: ReviewableIssue[] = [];

  // Delivered work to judge (#delivered-step). Issues to confirm come from
  // openIssueConfirmations() in the work feed (#714).
  if (reviewType === "test") {
    const testCandidates = await prisma.bug.findMany({
      where: {
        tenantId: agent.tenantId,
        projectId,
        isDeleted: false,
        status: "delivered",
        pullRequestUrl: { not: null },
        testVerdicts: {
          none: {
            agentId: agent.agentId,
          },
        },
      },
      take: limit,
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        number: true,
        title: true,
        projectId: true,
        pullRequestUrl: true,
        reporterId: true,
        beneficiaryUserId: true,
        createdByAgentId: true,
        createdByAgent: { select: { ownerUserId: true } },
        createdAt: true,
        claims: {
          where: { status: "active", releasedAt: null },
          select: { agentId: true, beneficiaryUserId: true, agent: { select: { ownerUserId: true } } },
        },
      },
    });

    for (const bug of testCandidates) {
      if (results.length >= limit) break;

      const reviewed = {
        reporterId: bug.reporterId,
        beneficiaryUserId: bug.beneficiaryUserId,
        createdByAgentId: bug.createdByAgentId,
        createdByAgent: bug.createdByAgent,
        claims: bug.claims.map((c) => ({
          status: "active" as const,
          releasedAt: null,
          agentId: c.agentId,
          beneficiaryUserId: c.beneficiaryUserId,
          agent: c.agent,
        })),
      };
      if (reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, reviewed)) continue;

      results.push({
        id: bug.id,
        number: bug.number,
        title: bug.title,
        projectId: bug.projectId,
        stage: "ready",
        reviewType: "test",
        pullRequestUrl: bug.pullRequestUrl,
        createdAt: bug.createdAt,
      });
    }
  }

  return results;
}
