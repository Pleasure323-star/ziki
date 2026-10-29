import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { awardBid } from "@/lib/agent-api/bid";
import { confirmedIssueIds } from "@/lib/issue-stage";
import { isOfferExpired } from "@/lib/agent-api/offer";
import { workflowFor } from "@/lib/workflow";
import { logger } from "@/lib/logger";

export type BidSweepResult = {
  invited: number;
  assigned: number;
  lapsed: number;
  errors: Array<{ issueId: string; error: string }>;
};

/**
 * Direct Fair Bid Auto-Assignment Sweep
 *
 * Automatically assigns open bids on confirmed issues directly without a comment handshake:
 *
 * 1. Scans for open, confirmed issues with pending bids and no active assignee/claim.
 * 2. Selects a bidder fairly so all agents and contributors have an equal chance at tasks:
 *     - Prioritizes bidders with fewest active claims (workload balancing).
 *     - Prioritizes bidders with fewest total historical tasks in the project.
 *     - Uses earliest bid creation time as tie-breaker (FIFO).
 * 3. Immediately awards the bid and assigns the task to the selected bidder.
 *
 * The award records itself (the bid, the claim, the assignee and status
 * activity, and `issue.bid_awarded`), so the sweep posts no comment.
 */
export async function sweepPendingBids(options?: {
  now?: Date;
  responseWindowMs?: number;
  limit?: number;
}): Promise<BidSweepResult> {
  const now = options?.now ?? new Date();
  const limit = options?.limit ?? 200;

  const result: BidSweepResult = {
    invited: 0,
    assigned: 0,
    lapsed: 0,
    errors: [],
  };

  // Open, unassigned issues with pending bids and no active claim.
  const withBids: Prisma.BugWhereInput = {
    status: "open",
    assigneeId: null,
    claims: { none: { releasedAt: null, status: "active" } },
    bids: { some: { withdrawnAt: null, awardedAt: null } },
  };
  // Readiness from one bulk read, before the limit, so unconfirmed issues
  // can't fill the page (#714).
  const confirmed = await confirmedIssueIds(prisma, withBids);
  if (confirmed.size === 0) return result;
  const candidateIssues = await prisma.bug.findMany({
    where: { ...withBids, id: { in: [...confirmed] }, isDeleted: false },
    select: {
      id: true,
      title: true,
      number: true,
      tenantId: true,
      projectId: true,
      reporterId: true,
      severity: true,
      voteCount: true,
      claims: { where: { releasedAt: null, status: "offered" }, select: { offeredAt: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });

  for (const issue of candidateIssues) {
    try {
      // A live offer still holds the issue; one past the project's offer
      // window does not, as everywhere else offers are judged.
      const { offerWindowSeconds } = await workflowFor(issue.projectId);
      if (issue.claims.some((claim) => !isOfferExpired(claim.offeredAt, now.getTime(), offerWindowSeconds * 1000))) continue;

      // Find all open, unawarded bids on this issue
      const openBids = await prisma.issueBid.findMany({
        where: {
          bugId: issue.id,
          withdrawnAt: null,
          awardedAt: null,
        },
        include: {
          agent: {
            select: {
              id: true,
              name: true,
              ownerUserId: true,
              revokedAt: true,
            },
          },
          beneficiary: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      });

      if (openBids.length === 0) continue;

      // Build fairness candidate list
      const candidateBidders = [];
      for (const bid of openBids) {
        if (bid.agent.revokedAt) continue;

        // Active claims check for this bidder's beneficiary in this project
        // Used for fair workload-balancing sorting (fewest active claims first)
        const activeClaimsCount = await prisma.issueClaim.count({
          where: {
            beneficiaryUserId: bid.beneficiaryUserId,
            status: "active",
            releasedAt: null,
            bug: { tenantId: issue.tenantId, projectId: issue.projectId, isDeleted: false },
          },
        });

        // Total historical tasks awarded in this project
        const totalAwardedClaimsCount = await prisma.issueClaim.count({
          where: {
            beneficiaryUserId: bid.beneficiaryUserId,
            claimedAt: { not: null },
            bug: { tenantId: issue.tenantId, projectId: issue.projectId, isDeleted: false },
          },
        });

        candidateBidders.push({
          bid,
          activeClaimsCount,
          totalAwardedClaimsCount,
        });
      }

      if (candidateBidders.length === 0) continue;

      // Fairness sorting:
      // 1. Fewest current active tasks (workload balancing)
      // 2. Fewest historical tasks awarded in project (fair opportunity)
      // 3. Earliest bid createdAt (FIFO tie-breaker)
      candidateBidders.sort((a, b) => {
        if (a.activeClaimsCount !== b.activeClaimsCount) {
          return a.activeClaimsCount - b.activeClaimsCount;
        }
        if (a.totalAwardedClaimsCount !== b.totalAwardedClaimsCount) {
          return a.totalAwardedClaimsCount - b.totalAwardedClaimsCount;
        }
        return a.bid.createdAt.getTime() - b.bid.createdAt.getTime();
      });

      const selected = candidateBidders[0].bid;
      const authorId = issue.reporterId ?? selected.beneficiaryUserId ?? "system";

      // Directly award the bid to the fair winner!
      await awardBid(
        { id: authorId, role: "super_admin" },
        selected.id,
      );

      result.assigned++;
    } catch (error) {
      logger.error(`[cron] Error processing bids for issue ${issue.id}:`, error);
      result.errors.push({
        issueId: issue.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
