import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertKeyProject, type AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { audit } from "@/lib/agents/audit";
import { IssueApiError } from "@/lib/agent-api/errors";
import { publish } from "@/lib/agent-api/events";
import { afterAward, awardInTransaction, type AwardResult } from "@/lib/agent-api/bid";
import { workflowFor } from "@/lib/workflow";
import { isThresholdOnly, thresholdDecision, weightedTally } from "@/lib/governance";
import { isAtCapacityError } from "@/lib/agent-api/capacity";

/**
 * Bid votes (#bid-votes). When a bid comes in, other agents vote it up if they
 * think it is good, and a manager agent awards one bid as an offer
 * (lib/agent-api/bid.ts `awardBid`). One vote per person per bid; voting
 * again is fine and is counted once. Nobody votes for their own owner's bid.
 *
 * In a manager-governed project a bid's votes are the people who voted for it,
 * for the manager to read. In a threshold-only project (#vote-governance) the
 * tally is weighted (lib/governance.ts): a manager or merger agent's vote
 * counts the project's `managerVoteWeight`, any other counts 1, and the vote that brings a bid to the
 * project's `awardThreshold` awards it, in the same transaction, as a
 * manager's award would. If the issue can't be awarded right then (an offer is
 * still pending), the vote stands and the award waits.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** A bid's weighted tally. */
export async function bidTally(bidId: string, managerVoteWeight: number, db: Db = prisma): Promise<number> {
  const votes = await db.bidVote.findMany({ where: { bidId }, select: { onBehalfOfUserId: true, agent: { select: { level: true } } } });
  return weightedTally(votes.map((vote) => ({ ownerId: vote.onBehalfOfUserId, level: vote.agent?.level })), managerVoteWeight);
}

export type BidVoteResult = {
  bidId: string;
  /** The bid's votes: weighted in a threshold-only project, the people who voted otherwise. */
  votes: number;
  /** The project's awardThreshold, in a threshold-only project; null otherwise. */
  threshold: number | null;
  /** True when this vote awarded the bid (threshold-only). */
  awarded: boolean;
  /** The offer's claim, when it awarded the bid. */
  claimId?: string;
  /** Why the bid at the threshold was not awarded yet, when that happened: `at_capacity` when its bidder holds the project's limit, else the reason in words. */
  awardBlocked?: string;
};

/**
 * `POST /api/v1/bids/{id}/votes` (working): vote for an open bid. The bid must
 * not be awarded or withdrawn, and its issue must be Open. 403 `own_bid` when
 * the voter's owner is the bid's beneficiary or its agent's owner.
 */
export async function voteForBid(agent: AgentContext, projectId: string, bidId: string): Promise<BidVoteResult> {
  requireLevel(agent, "working");
  assertKeyProject(agent, projectId);
  const found = await prisma.issueBid.findUnique({
    where: { id: bidId },
    select: { id: true, bugId: true, bug: { select: { tenantId: true, projectId: true, isDeleted: true } } },
  });
  if (!found || found.bug.tenantId !== agent.tenantId || found.bug.projectId !== projectId || found.bug.isDeleted) {
    throw new IssueApiError(404, "Bid not found.");
  }
  const workflow = await workflowFor(projectId);
  const thresholdOnly = isThresholdOnly(workflow);

  const result = await prisma.$transaction(async (tx) => {
    // Lock the issue as an award does, so a vote never lands on a bid being awarded.
    await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${found.bugId} AND "isDeleted" = false FOR UPDATE`;
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
    // Weighted where the votes decide the award; in a manager-governed project, the people who voted.
    const votes = thresholdOnly ? await bidTally(bid.id, workflow.managerVoteWeight, tx) : await tx.bidVote.count({ where: { bidId: bid.id } });
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
    // Threshold-only (#vote-governance): the vote that reaches awardThreshold awards the bid.
    let award: AwardResult | null = null;
    let awardBlocked: string | undefined;
    if (thresholdOnly && votes >= workflow.awardThreshold) {
      const by = { userId: agent.ownerId, agentId: agent.agentId };
      try {
        award = await awardInTransaction(tx, bid.id, by, thresholdDecision(by, votes, workflow.awardThreshold));
      } catch (error) {
        // A refused award writes nothing (awardInTransaction), so the vote still stands.
        if (!(error instanceof IssueApiError) || error.status !== 409) throw error;
        // A bid at capacity is skipped (#bidder-capacity): the code, so agents can tell it apart.
        awardBlocked = isAtCapacityError(error) ? "at_capacity" : error.message;
      }
    }
    return { bidId: bid.id, bugId: bid.bugId, votes, created: created.count > 0, award, awardBlocked };
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new IssueApiError(409, "This issue already has an active claim.");
    }
    throw error;
  });
  if (result.created) {
    await audit(agent, "issue.bid_voted", `issue:${result.bugId}`, { bidId: result.bidId, votes: result.votes }, { bugId: result.bugId });
  }
  if (result.award) {
    await audit(
      agent,
      "issue.bid_awarded",
      `issue:${result.bugId}`,
      { bidId: result.bidId, claimId: result.award.claimId, votes: result.votes, threshold: workflow.awardThreshold, via: "threshold" },
      { bugId: result.bugId },
    );
    afterAward(result.award);
  }
  return {
    bidId: result.bidId,
    votes: result.votes,
    threshold: thresholdOnly ? workflow.awardThreshold : null,
    awarded: Boolean(result.award),
    ...(result.award ? { claimId: result.award.claimId } : {}),
    ...(result.awardBlocked ? { awardBlocked: result.awardBlocked } : {}),
  };
}
