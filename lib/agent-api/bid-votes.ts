import { prisma } from "@/lib/prisma";
import { assertKeyProject, type AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { audit } from "@/lib/agents/audit";
import { IssueApiError } from "@/lib/agent-api/errors";
import { publish } from "@/lib/agent-api/events";

/**
 * Bid votes (#bid-votes). When a bid comes in, other agents vote it up if they
 * think it is good, and a manager agent awards one bid as an offer
 * (lib/agent-api/bid.ts `awardBid`). One vote per person per bid, each
 * counting 1; voting again is fine and is counted once. Nobody votes for
 * their own owner's bid.
 */

/**
 * `POST /api/v1/bids/{id}/votes` (working): vote for an open bid. The bid must
 * not be awarded or withdrawn, and its issue must be Open. 403 `own_bid` when
 * the voter's owner is the bid's beneficiary or its agent's owner.
 */
export async function voteForBid(agent: AgentContext, projectId: string, bidId: string): Promise<{ bidId: string; votes: number }> {
  requireLevel(agent, "working");
  assertKeyProject(agent, projectId);
  const found = await prisma.issueBid.findUnique({
    where: { id: bidId },
    select: { id: true, bugId: true, bug: { select: { tenantId: true, projectId: true, isDeleted: true } } },
  });
  if (!found || found.bug.tenantId !== agent.tenantId || found.bug.projectId !== projectId || found.bug.isDeleted) {
    throw new IssueApiError(404, "Bid not found.");
  }

  const result = await prisma.$transaction(async (tx) => {
    // Lock the issue, as an award does, so a vote never lands on a bid being awarded.
    await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${found.bugId} AND "isDeleted" = false FOR NO KEY UPDATE`;
    const bid = await tx.issueBid.findUnique({
      where: { id: bidId },
      select: {
        id: true, bugId: true, agentId: true, beneficiaryUserId: true, withdrawnAt: true, awardedAt: true,
        agent: { select: { ownerUserId: true } },
        bug: { select: { number: true, status: true } },
      },
    });
    if (!bid) throw new IssueApiError(404, "Bid not found.");
    if (bid.withdrawnAt || bid.awardedAt) throw new IssueApiError(409, "This bid is no longer open.");
    if (bid.bug.status !== "open") throw new IssueApiError(409, "Only bids on open issues take votes.");
    if (agent.ownerId === bid.beneficiaryUserId || agent.ownerId === bid.agent.ownerUserId) {
      const message = "This is your owner's own bid; other agents vote for it.";
      throw new IssueApiError(403, message, { error: "own_bid", message });
    }
    const created = await tx.bidVote.createMany({
      data: [{ bidId: bid.id, bugId: bid.bugId, onBehalfOfUserId: agent.ownerId, agentId: agent.agentId }],
      skipDuplicates: true,
    });
    const votes = await tx.bidVote.count({ where: { bidId: bid.id } });
    if (created.count) {
      await publish(tx, {
        tenantId: agent.tenantId,
        type: "issue.bid_voted",
        actorAgentId: agent.agentId,
        bugId: bid.bugId,
        projectId,
        payload: { bidId: bid.id, issueId: bid.bugId, issueNumber: bid.bug.number, projectId, bidAgentId: bid.agentId, votes },
      });
    }
    return { bidId: bid.id, bugId: bid.bugId, votes, created: created.count > 0 };
  });
  if (result.created) {
    await audit(agent, "issue.bid_voted", `issue:${result.bugId}`, { bidId: result.bidId, votes: result.votes }, { bugId: result.bugId });
  }
  return { bidId: result.bidId, votes: result.votes };
}
