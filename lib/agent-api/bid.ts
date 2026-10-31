import { z } from "zod";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertKeyProject, type AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { IssueApiError } from "@/lib/agent-api/errors";
import { isConfirmed } from "@/lib/agent-api/confirmations";
import { publish } from "@/lib/agent-api/events";
import { workflowFor } from "@/lib/workflow";
import { isOfferExpired, scheduleOfferExpiry } from "@/lib/agent-api/offer";
import { notifyClaimOffered } from "@/lib/agent-notifications";
import { assertRedesignOpen } from "@/lib/redesigns";
import { issueIdFor, parseIssueRef } from "@/lib/issue-ref";
import { entryDescription, entrySummary } from "@/lib/agent-api/entry-fields";
import { clearStaleAssignee } from "@/lib/agent-api/stale-assignee";
import { OPEN_BID_WHERE } from "@/lib/open-bids";
import { weightedTally, type ThresholdDecision } from "@/lib/governance";
import { assertUnderCapacity } from "@/lib/agent-api/capacity";

/**
 * Bids (#issue-bids). Under Open an issue's entries are bids: one per agent,
 * each an offer to fix it with a summary of at most two sentences and a full
 * description (the same written part as every stage entry,
 * lib/agent-api/entry-fields.ts). Placing it again replaces it. Replies to a
 * bid are plain comments with `bidId`. Only agents bid — an award makes the
 * bidding agent's claim — so bids stay one per agent, not per person.
 * A bid does not assign the issue: agents vote for the bids they think are
 * good (lib/agent-api/bid-votes.ts), weighted by lib/governance.ts, and once a
 * bid's votes reach the project's `awardThreshold` any agent may award it as
 * an offer the bidding agent accepts. In a threshold-only project
 * (#vote-governance) the vote that brings a bid to the threshold also awards
 * it on its own.
 */
const id = z.string().trim().min(1).max(191);
export const bidSchema = z.object({
  projectId: id.optional(),
  summary: entrySummary,
  description: entryDescription,
}).strict();

export type BidInput = { summary: string; description: string };

/** Parses a raw bid body, throwing a 400 `IssueApiError` that names the field. */
export function parseBid(raw: unknown): z.infer<typeof bidSchema> {
  const parsed = bidSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
  const message =
    issue?.code === "unrecognized_keys"
      ? `Unknown field: ${(issue as { keys?: string[] }).keys?.join(", ")}. Send summary and description.`
      : field === "summary" && issue?.code === "invalid_type"
        ? "Add a summary."
        : field === "description" && issue?.code === "invalid_type"
          ? "Add a description of how you will fix it."
          : issue?.message ?? "Invalid bid.";
  throw new IssueApiError(400, message, { error: "invalid_request", message, ...(field ? { field } : {}) });
}

type Tx = Prisma.TransactionClient;

/**
 * A live offer or an active claim already has this task. An expired offer does
 * not; "expired" uses the project's offer window, like every other offer path.
 */
async function competingClaim(tx: Tx, bugId: string) {
  const current = await tx.issueClaim.findFirst({
    where: { bugId, releasedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, offeredAt: true, agentId: true, beneficiaryUserId: true, bug: { select: { tenantId: true, projectId: true } } },
  });
  if (!current) return null;
  const { offerWindowSeconds } = await workflowFor(current.bug.projectId, tx);
  if (current.status === "offered" && isOfferExpired(current.offeredAt, Date.now(), offerWindowSeconds * 1000)) return { expired: current };
  if (current.status === "offered") throw new IssueApiError(409, "This issue has a pending offer.");
  if (current.status === "active") throw new IssueApiError(409, "This issue is already being worked.");
  return null;
}

/**
 * An agent bids for a task, or replaces its open bid. The issue stays open
 * until a bid is awarded. `replaced` is true when it updated an open bid.
 */
export async function placeBid(caller: AgentContext, projectId: string, issueRef: string, input: BidInput) {
  assertKeyProject(caller, projectId);
  const ref = parseIssueRef(issueRef);
  return prisma.$transaction(async (tx) => {
    let bugId: string;
    if (ref.kind === "number") {
      const resolved = await tx.bug.findFirst({
        where: { number: ref.number, tenantId: caller.tenantId, projectId, isDeleted: false },
        select: { id: true },
      });
      if (!resolved) throw new IssueApiError(404, "Issue not found in this project.");
      bugId = resolved.id;
    } else {
      bugId = ref.id;
    }
    // Resolve readable numbers first, then lock and re-read the canonical row
    // inside the same scope before checking readiness or creating a bid.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Bug" WHERE "id" = ${bugId} AND "tenantId" = ${caller.tenantId} AND "projectId" = ${projectId} AND "isDeleted" = false FOR UPDATE`;
    if (!locked.length) throw new IssueApiError(404, "Issue not found in this project.");
    const bug = await tx.bug.findFirst({
      where: { id: bugId, tenantId: caller.tenantId, projectId, isDeleted: false },
      select: { id: true, projectId: true, status: true, voteCount: true },
    });
    if (!bug) throw new IssueApiError(404, "Issue not found in this project.");
    if (bug.status !== "open") throw new IssueApiError(409, "Only open issues can take bids.");
    // One rule for ready: confirmed under isConfirmed(), no second check (#714).
    const isReady = await isConfirmed(bugId, tx);
    if (!isReady) {
      throw new IssueApiError(409, "This is not ready yet. Reviewers confirm an issue before it can be passed on.");
    }
    await assertRedesignOpen(bugId, tx);
    await competingClaim(tx, bugId);

    const existing = await tx.issueBid.findUnique({ where: { bugId_agentId: { bugId, agentId: caller.agentId } } });
    if (existing?.awardedAt) throw new IssueApiError(409, "This bid was already awarded.");
    const written = { summary: input.summary, description: input.description };
    if (existing && !existing.withdrawnAt) {
      const bid = await tx.issueBid.update({ where: { id: existing.id }, data: written });
      return { bid, replaced: true as const };
    }

    const bid = existing
      ? await tx.issueBid.update({
          where: { id: existing.id },
          data: { ...written, withdrawnAt: null, beneficiaryUserId: caller.ownerId },
        })
      : await tx.issueBid.create({
          data: { bugId, agentId: caller.agentId, beneficiaryUserId: caller.ownerId, ...written },
        });
    await publish(tx, {
      tenantId: caller.tenantId,
      type: "issue.bid",
      actorAgentId: caller.agentId,
      bugId,
      payload: { bidId: bid.id, issueId: bugId, projectId, beneficiaryUserId: caller.ownerId, summary: bid.summary },
    });
    return { bid, replaced: false as const };
  });
}

type Db = PrismaClient | Prisma.TransactionClient;

/** One open bid as the API and the issue page show it, with its replies. */
export type BidEntry = {
  id: string;
  agentId: string;
  agentName: string;
  beneficiaryUserId: string;
  /** The agent's owner, for whom it bids. */
  by: string;
  summary: string;
  description: string;
  areaMatch: boolean;
  /**
   * Its weighted votes (#bid-votes, lib/governance.ts weightedTally): one per
   * person, a manager or merger agent's counting the project's
   * managerVoteWeight. What the project's awardThreshold counts.
   */
  votes: number;
  /** Set on a bid that was awarded (it got the task), for the read-only history. */
  awardedAt?: Date | null;
  /**
   * The award's claim was released (let go, expired or revoked), so the issue
   * went back to Open: it is no longer the issue's award.
   */
  awardReleasedAt?: Date | null;
  /** The award is an offer its agent has not accepted yet; the issue stays Open meanwhile. */
  awardPending?: boolean;
  /** The award's offer was not accepted within the project's offer window. */
  awardExpired?: boolean;
  /** Set on a bid that was withdrawn. */
  withdrawnAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  replies: { id: string; body: string; authorId: string; agentId: string | null; authorName: string; agentName: string | null; createdAt: Date; editedAt: Date | null }[];
};

/**
 * The open bids on one issue (not withdrawn, not awarded, from agents that
 * are not revoked), a matching area first, then oldest first.
 */
export async function openBidEntries(bug: { id: string; areaId: string | null }, db: Db = prisma): Promise<BidEntry[]> {
  return bidEntries(bug, { bugId: bug.id, ...OPEN_BID_WHERE }, db);
}

/**
 * Every bid the issue took, awarded and withdrawn ones too, for the read-only
 * history once it has left Open (#entry-replies-only).
 */
export async function bidHistoryEntries(bug: { id: string; areaId: string | null }, db: Db = prisma): Promise<BidEntry[]> {
  return bidEntries(bug, { bugId: bug.id }, db);
}

async function bidEntries(bug: { id: string; areaId: string | null }, where: Prisma.IssueBidWhereInput, db: Db): Promise<BidEntry[]> {
  const rows = await db.issueBid.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      awardedAt: true,
      withdrawnAt: true,
      claim: { select: { status: true, releasedAt: true, releaseReason: true, claimedAt: true, offeredAt: true, bug: { select: { projectId: true } } } },
      agentId: true,
      beneficiaryUserId: true,
      summary: true,
      description: true,
      createdAt: true,
      updatedAt: true,
      beneficiary: { select: { name: true } },
      votes: { select: { onBehalfOfUserId: true, agent: { select: { level: true } } } },
      bug: { select: { projectId: true } },
      agent: { select: { name: true, areaPreferences: {
        where: { projectAreaId: bug.areaId ?? "" },
        select: { projectAreaId: true },
      } } },
      replies: {
        where: { deletedAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true, body: true, authorId: true, agentId: true, createdAt: true, editedAt: true,
          author: { select: { name: true } },
          agent: { select: { name: true } },
        },
      },
    },
  });
  // An offer past the project's offer window is expired even before the sweeper releases it.
  const projectId = rows[0]?.bug?.projectId;
  const workflow = projectId ? await workflowFor(projectId, db) : null;
  const offerWindowMs = workflow ? workflow.offerWindowSeconds * 1000 : 0;
  const managerVoteWeight = workflow?.managerVoteWeight ?? 1;
  const now = Date.now();
  return rows
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ agent, beneficiary, replies, claim, votes, bug: _bug, ...bid }) => {
      const lapsed = claim?.status === "offered" && isOfferExpired(claim.offeredAt, now, offerWindowMs);
      const expired = Boolean(bid.awardedAt && claim && !claim.claimedAt
        && (lapsed || (claim.status === "released" && claim.releaseReason === "expired")));
      return {
      ...bid,
      // Awarded only while its claim is current: an award whose claim was released, or
      // that has no claim on record (older data), no longer holds the task.
      awardReleasedAt: bid.awardedAt && (!claim || claim.status === "released") ? (claim?.releasedAt ?? bid.awardedAt) : null,
      awardPending: Boolean(bid.awardedAt && claim?.status === "offered" && !lapsed),
      awardExpired: expired,
      agentName: agent.name,
      by: beneficiary.name ?? "A member",
      areaMatch: Boolean(bug.areaId && agent.areaPreferences.length),
      votes: weightedTally((votes ?? []).map((vote) => ({ ownerId: vote.onBehalfOfUserId, level: vote.agent?.level })), managerVoteWeight),
      replies: (replies ?? []).map(({ author, agent: replyAgent, ...reply }) => ({
        ...reply,
        authorName: author.name ?? "A member",
        agentName: replyAgent?.name ?? null,
      })),
      };
    })
    .sort((a, b) => Number(b.areaMatch) - Number(a.areaMatch) || a.createdAt.getTime() - b.createdAt.getTime());
}

export async function listBids(caller: AgentContext, projectId: string, bugId: string) {
  assertKeyProject(caller, projectId);
  const ref = parseIssueRef(bugId);
  const bug = await prisma.bug.findFirst({
    where: { ...(ref.kind === "number" ? { number: ref.number } : { id: ref.id }), tenantId: caller.tenantId, projectId, isDeleted: false },
    select: { id: true, areaId: true },
  });
  if (!bug) throw new IssueApiError(404, "Issue not found in this project.");
  return openBidEntries(bug);
}

/** The bidding agent takes its own bid back. Awarded bids stay. */
export async function withdrawBid(caller: AgentContext, projectId: string, issueRef: string) {
  return prisma.$transaction(async (tx) => {
    // #457: the path may be the readable number (`123`, `ZE-123`) or the id.
    const bugId = await issueIdFor(tx, issueRef, caller.tenantId);
    if (!bugId) throw new IssueApiError(404, "Bid not found.");
    const bid = await tx.issueBid.findUnique({
      where: { bugId_agentId: { bugId, agentId: caller.agentId } },
      include: { bug: { select: { tenantId: true, projectId: true, isDeleted: true } } },
    });
    if (!bid || bid.bug.tenantId !== caller.tenantId || bid.bug.projectId !== projectId || bid.bug.isDeleted) {
      throw new IssueApiError(404, "Bid not found.");
    }
    await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${bugId} AND "isDeleted" = false FOR NO KEY UPDATE`;
    const fresh = await tx.issueBid.findUnique({ where: { id: bid.id } });
    if (!fresh) throw new IssueApiError(404, "Bid not found.");
    if (fresh.awardedAt) throw new IssueApiError(409, "This bid was already awarded.");
    if (fresh.withdrawnAt) return fresh;
    const withdrawnAt = new Date();
    const updated = await tx.issueBid.updateMany({
      where: { id: fresh.id, awardedAt: null, withdrawnAt: null },
      data: { withdrawnAt },
    });
    if (updated.count !== 1) throw new IssueApiError(409, "This bid was already awarded.");
    await publish(tx, {
      tenantId: caller.tenantId,
      type: "issue.bid_withdrawn",
      actorAgentId: caller.agentId,
      bugId,
      payload: { bidId: fresh.id, issueId: bugId, projectId },
    });
    return { ...fresh, withdrawnAt };
  });
}

/** A bid's weighted tally (lib/governance.ts): one vote per person, a manager or merger agent's counting `managerVoteWeight`. */
export async function bidTally(bidId: string, managerVoteWeight: number, db: Db = prisma): Promise<number> {
  const votes = await db.bidVote.findMany({ where: { bidId }, select: { onBehalfOfUserId: true, agent: { select: { level: true } } } });
  return weightedTally(votes.map((vote) => ({ ownerId: vote.onBehalfOfUserId, level: vote.agent?.level })), managerVoteWeight);
}

/**
 * `POST /api/v1/bids/{id}/award` (working): any agent awards a bid whose
 * weighted votes reached the project's `awardThreshold` (#bid-votes), in
 * either governance mode. Below it the award is refused for everyone,
 * managers included (409 `below_threshold`, with `votes` and `threshold`); a
 * manager's vote counts `managerVoteWeight`, so a manager can vote a bid up
 * to the threshold alone and then award it. There is no own-owner rule: the
 * votes gate it. The award is an offer to the bidding agent: once it accepts,
 * its owner becomes the assignee, the issue moves to In progress and the
 * other bids are withdrawn (acceptOffer). An offer that lapses frees the
 * issue for another award. 409 `at_capacity` for a bid whose person already
 * holds the project's maxActiveClaims in live offers and active claims
 * (lib/agent-api/capacity.ts).
 */
export async function awardBid(agent: AgentContext, bidId: string) {
  requireLevel(agent, "working");
  try {
    const result = await prisma.$transaction(async (tx) => {
      const bid = await tx.issueBid.findUnique({
        where: { id: bidId },
        include: { bug: { select: { id: true, title: true, tenantId: true, projectId: true, isDeleted: true } } },
      });
      if (!bid || bid.bug.isDeleted || bid.bug.tenantId !== agent.tenantId) throw new IssueApiError(404, "Bid not found.");
      assertKeyProject(agent, bid.bug.projectId);
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Bug" WHERE "id" = ${bid.bugId} AND "isDeleted" = false FOR UPDATE`;
      if (!locked.length) throw new IssueApiError(404, "Bid not found.");
      const { awardThreshold, managerVoteWeight } = await workflowFor(bid.bug.projectId, tx);
      const votes = await bidTally(bid.id, managerVoteWeight, tx);
      if (votes < awardThreshold) {
        const message = `This bid has ${votes} of the ${awardThreshold} votes it needs before it can be awarded.`;
        throw new IssueApiError(409, message, { error: "below_threshold", message, votes, threshold: awardThreshold });
      }
      return awardInTransaction(tx, bidId, { userId: agent.ownerId, agentId: agent.agentId });
    });
    afterAward(result);
    return result;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new IssueApiError(409, "This issue already has an active claim.");
    }
    throw error;
  }
}

export type AwardResult = { bidId: string; claimId: string; bugId: string; bugTitle: string; beneficiaryUserId: string };

/**
 * Awards an open bid as an offer, in the caller's transaction, with its issue
 * row already locked FOR UPDATE. The issue must be Open and confirmed, held by
 * nobody (a stale assignee is cleared, an expired offer released). An
 * agent's award of a bid at the threshold and, in a threshold-only project,
 * the bid vote that reaches the project's `awardThreshold` (`decision`,
 * lib/agent-api/bid-votes.ts) both end here; `by` is who awarded it, or who cast the deciding vote. Throws a
 * 409 `IssueApiError` before writing anything when a rule stops the award.
 * The caller runs `afterAward` once the transaction commits.
 */
export async function awardInTransaction(
  tx: Tx,
  bidId: string,
  by: { userId: string; agentId: string | null },
  decision?: ThresholdDecision,
): Promise<AwardResult> {
  const fresh = await tx.issueBid.findUnique({
    where: { id: bidId },
    include: {
      beneficiary: { select: { name: true } },
      bug: { select: { id: true, title: true, status: true, assigneeId: true, tenantId: true, projectId: true, reporterId: true, voteCount: true, assignee: { select: { name: true } } } },
    },
  });
  if (!fresh || fresh.withdrawnAt || fresh.awardedAt) throw new IssueApiError(409, "This bid is no longer open.");
  if (fresh.bug.status !== "open") throw new IssueApiError(409, "Only open issues can be awarded.");
  // One rule for ready: confirmed under isConfirmed(), no second check (#714).
  const isReady = await isConfirmed(fresh.bugId, tx);
  if (!isReady) {
    throw new IssueApiError(409, "This is not ready yet. Reviewers confirm an issue before it can be passed on.");
  }
  // Bidder capacity (#bidder-capacity): no award to a person whose agents
  // already hold the project's maxActiveClaims in live offers and active
  // claims. Their row is locked as acceptOffer locks it, so two awards can't
  // both slip under the limit.
  const workflow = await workflowFor(fresh.bug.projectId, tx);
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${fresh.beneficiaryUserId} FOR UPDATE`;
  await assertUnderCapacity(tx, { tenantId: fresh.bug.tenantId, projectId: fresh.bug.projectId, userId: fresh.beneficiaryUserId }, workflow);
  // An assignee with no active claim and no live offer is stale: clear it
  // and award, as the work feed lists the issue (#stale-assignee). One that
  // still holds the issue keeps it. Clearing happens only when nothing holds
  // the issue, so none of the refusals below can follow a write.
  const cleared = await clearStaleAssignee(tx, fresh.bug, by);
  if (!cleared && fresh.bug.assigneeId && fresh.bug.assigneeId !== fresh.beneficiaryUserId) {
    throw new IssueApiError(409, "This issue is already assigned to someone else.");
  }
  const existingActive = await tx.issueClaim.findFirst({
    where: { bugId: fresh.bugId, status: "active", releasedAt: null },
  });
  if (existingActive) {
    throw new IssueApiError(409, "This issue already has an active claim.");
  }
  const now = new Date();
  const competing = await competingClaim(tx, fresh.bugId);
  if (competing?.expired) {
    await tx.issueClaim.update({
      where: { id: competing.expired.id },
      data: { status: "released", releasedAt: now, releaseReason: "expired" },
    });
    await publish(tx, {
      tenantId: competing.expired.bug.tenantId,
      type: "claim.released",
      actorAgentId: competing.expired.agentId,
      bugId: fresh.bugId,
      payload: { claimId: competing.expired.id, issueId: fresh.bugId, beneficiaryUserId: competing.expired.beneficiaryUserId, reason: "expired" },
    });
  }

  // The award is an offer: the agent accepts it (POST /api/v1/offers/{id}/accept)
  // before it has the task. Until then the issue stays Open, the other bids
  // stay open, and no second award or offer is possible (competingClaim).
  const { offerWindowSeconds } = workflow;
  const claim = await tx.issueClaim.create({
    data: {
      bugId: fresh.bugId,
      beneficiaryUserId: fresh.beneficiaryUserId,
      agentId: fresh.agentId,
      // Picking a bid is not dispatching: whoever awarded it stays independent to review the fix.
      status: "offered",
      offeredAt: now,
    },
  });
  const marked = await tx.issueBid.updateMany({
    where: { id: fresh.id, awardedAt: null, withdrawnAt: null },
    data: { awardedAt: now, claimId: claim.id },
  });
  if (marked.count !== 1) throw new IssueApiError(409, "This bid is no longer open.");
  await publish(tx, {
    tenantId: fresh.bug.tenantId,
    type: "claim.offered",
    actorAgentId: fresh.agentId,
    bugId: fresh.bugId,
    payload: {
      claimId: claim.id,
      issueId: fresh.bugId,
      projectId: fresh.bug.projectId,
      beneficiaryUserId: fresh.beneficiaryUserId,
      bidId: fresh.id,
      expiresAt: new Date(now.getTime() + offerWindowSeconds * 1000).toISOString(),
    },
  });
  await publish(tx, {
    tenantId: fresh.bug.tenantId,
    type: "issue.bid_awarded",
    actorAgentId: fresh.agentId,
    bugId: fresh.bugId,
    payload: {
      bidId: fresh.id, claimId: claim.id, issueId: fresh.bugId, projectId: fresh.bug.projectId, beneficiaryUserId: fresh.beneficiaryUserId,
      awardedByAgentId: by.agentId, offered: true,
      ...(decision ?? {}),
    },
  });
  return { bidId: fresh.id, claimId: claim.id, bugId: fresh.bugId, bugTitle: fresh.bug.title, beneficiaryUserId: fresh.beneficiaryUserId };
}

/** After an award commits: tell the agent's owner, and lapse the offer if nobody accepts it in time. */
export function afterAward(result: AwardResult): void {
  notifyClaimOffered({ id: result.claimId, bugId: result.bugId, bugTitle: result.bugTitle, beneficiaryUserId: result.beneficiaryUserId });
  scheduleOfferExpiry(result.claimId);
}
