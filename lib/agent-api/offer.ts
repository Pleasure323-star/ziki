import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { IssueApiError } from "@/lib/agent-api/errors";
import { isConfirmed } from "@/lib/agent-api/confirmations";
import { publish } from "@/lib/agent-api/events";
import { notifyClaimOffered } from "@/lib/agent-notifications";
import { workflowFor } from "@/lib/workflow";
import { DEFAULT_PROJECT_WORKFLOW } from "@/lib/workflow-config";
import { canAssignTicket } from "@/lib/ticket-assignment";
import { assigneeChangedSummary, statusChangedSummary } from "@/lib/activity-log";
import { ensureWatching } from "@/lib/watch";
import { assertRedesignOpen } from "@/lib/redesigns";
import { assertApprovalOpen } from "@/lib/approvals";
import { deliveryDeadline, deliveryWindowMinutes } from "@/lib/claim-deadline";
import { hasLevel } from "@/lib/agents/levels";
import { parseIssueRef, resolveIssueRef } from "@/lib/issue-ref";

/** Pure helper/tests default; requests use the project's offerWindowSeconds. */
export const OFFER_TTL_MS = DEFAULT_PROJECT_WORKFLOW.offerWindowSeconds * 1000;
const id = z.string().trim().min(1).max(191);
export const offerSchema = z.object({ projectId: id.optional() }).strict();

type Db = typeof prisma | Prisma.TransactionClient;
export type OfferCandidate = { beneficiaryUserId: string; agentId: string; activeClaims: number; lastOfferedAt: Date | null; pendingOffer?: boolean; volunteered?: boolean; areaMatch?: boolean };

export function isOfferExpired(
  offeredAt: Date | null,
  now = Date.now(),
  windowMs = OFFER_TTL_MS,
): boolean {
  return !offeredAt || now - offeredAt.getTime() >= windowMs;
}

export function rankOfferCandidates<T extends OfferCandidate>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) =>
    (b.volunteered ? 1 : 0) - (a.volunteered ? 1 : 0)
    || a.activeClaims - b.activeClaims
    || Number(Boolean(b.areaMatch)) - Number(Boolean(a.areaMatch))
    || (a.lastOfferedAt?.getTime() ?? Number.NEGATIVE_INFINITY) - (b.lastOfferedAt?.getTime() ?? Number.NEGATIVE_INFINITY)
    || a.beneficiaryUserId.localeCompare(b.beneficiaryUserId));
}

export function availableOfferCandidates<T extends OfferCandidate>(
  candidates: T[],
  maxActiveClaims = DEFAULT_PROJECT_WORKFLOW.maxActiveClaims,
): T[] {
  return rankOfferCandidates(candidates.filter((person) => person.activeClaims < maxActiveClaims && !person.pendingOffer));
}

/**
 * Offers have a durable due date (`offeredAt + the project's offerWindowSeconds`) swept by the platform runner (#647).
 * Replaces in-process setTimeout so serverless and multi-instance deploys do not rely on dying timers (#527, #647).
 */
export function scheduleOfferExpiry(claimId?: string): void {
  void claimId;
  // Expiry is handled by sweepExpiredOffers on the scheduled runner.
}

/** Picks by active workload, then by who has waited longest since their last offer.
 * Exported for the stale-claim sweep (#524), which re-offers a reopened issue with no agent caller. */
export async function offerNext(db: Db, caller: { agentId?: string; tenantId: string; ownerId?: string; level?: AgentContext["level"] }, bug: { id: string; projectId: string; title: string; assigneeId?: string | null; areaId?: string | null }, excludeUserIds: string[] = []) {
  // Lock the Bug row first to serialize offer creation on this issue across concurrent calls (#680).
  await db.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${bug.id} FOR NO KEY UPDATE`;
  const workflow = await workflowFor(bug.projectId, db);
  const offerWindowMs = workflow.offerWindowSeconds * 1000;

  const existingOffer = await db.issueClaim.findFirst({
    where: {
      bugId: bug.id,
      releasedAt: null,
      OR: [
        { status: "active" },
        { status: "offered", offeredAt: { gt: new Date(Date.now() - offerWindowMs) } },
      ],
    },
    select: { id: true },
  });
  if (existingOffer) return null;
  const memberships = await db.membership.findMany({
    where: {
      tenantId: caller.tenantId,
      user: { agents: { some: { tenantId: caller.tenantId, revokedAt: null } } },
    },
    select: { userId: true, user: { select: { agents: {
      where: { tenantId: caller.tenantId, revokedAt: null },
      orderBy: { createdAt: "asc" }, select: {
        id: true,
        areaPreferences: { where: { projectAreaId: bug.areaId ?? "" }, select: { projectAreaId: true } },
      },
    } } } },
  });
  const people = memberships.flatMap((m) => {
    if (!m.user.agents.length || excludeUserIds.includes(m.userId) || (bug.assigneeId && bug.assigneeId !== m.userId)) return [];
    const preferred = bug.areaId ? m.user.agents.find((agent) => agent.areaPreferences.length > 0) : undefined;
    const selected = preferred ?? m.user.agents[0];
    return [{ beneficiaryUserId: m.userId, agentId: selected.id, areaMatch: Boolean(preferred) }];
  });
  if (!people.length) return null;

  const active = await db.issueClaim.groupBy({
    by: ["beneficiaryUserId"],
    where: { beneficiaryUserId: { in: people.map((p) => p.beneficiaryUserId) }, releasedAt: null, status: "active", bug: { tenantId: caller.tenantId, projectId: bug.projectId } },
    _count: { _all: true },
  });
  const counts = new Map(active.map((row) => [row.beneficiaryUserId, row._count._all]));
  const offers = await db.issueClaim.groupBy({
    by: ["beneficiaryUserId"],
    where: { beneficiaryUserId: { in: people.map((p) => p.beneficiaryUserId) }, offeredAt: { not: null }, bug: { tenantId: caller.tenantId } },
    _max: { offeredAt: true },
  });
  const lastOffered = new Map(offers.map((row) => [row.beneficiaryUserId, row._max.offeredAt]));

  const pendingCutoff = new Date(Date.now() - offerWindowMs);
  const pending = await db.issueClaim.groupBy({
    by: ["beneficiaryUserId"],
    where: {
      beneficiaryUserId: { in: people.map((p) => p.beneficiaryUserId) },
      status: "offered",
      releasedAt: null,
      offeredAt: { gt: pendingCutoff },
      bug: { tenantId: caller.tenantId },
    },
  });
  const pendingPeople = new Set(pending.map((row) => row.beneficiaryUserId));
  const candidates: OfferCandidate[] = people.map((p) => ({
    ...p, activeClaims: counts.get(p.beneficiaryUserId) ?? 0,
    lastOfferedAt: lastOffered.get(p.beneficiaryUserId) ?? null,
    pendingOffer: pendingPeople.has(p.beneficiaryUserId),
    areaMatch: p.areaMatch,
  }));

  const next = availableOfferCandidates(candidates, workflow.maxActiveClaims)[0];
  if (!next) return null;

  // Lock only the chosen member (#544) instead of looping over every member.
  await db.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${next.beneficiaryUserId} FOR NO KEY UPDATE`;
  try {
    const claim = await db.issueClaim.create({ data: {
      bugId: bug.id, beneficiaryUserId: next.beneficiaryUserId, agentId: next.agentId, status: "offered", offeredAt: new Date(),
      ...(caller.level && hasLevel(caller.level, "manager") && caller.ownerId ? { dispatcherUserId: caller.ownerId } : {}),
    } });
    const event = await publish(db, { tenantId: caller.tenantId, type: "claim.offered", actorAgentId: caller.agentId, bugId: bug.id,
      payload: { claimId: claim.id, issueId: bug.id, projectId: bug.projectId, beneficiaryUserId: next.beneficiaryUserId, expiresAt: new Date(claim.offeredAt!.getTime() + offerWindowMs).toISOString() } });
    return { claim, beneficiaryUserId: next.beneficiaryUserId, bugTitle: bug.title, eventId: event.id };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return null;
    }
    throw error;
  }
}

export async function offerIssue(agent: AgentContext, projectId: string, bugId: string) {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Bug" WHERE "id" = ${bugId} AND "tenantId" = ${agent.tenantId} AND "projectId" = ${projectId} AND "isDeleted" = false FOR UPDATE`;
      if (!locked.length) throw new IssueApiError(404, "Issue not found in this project.");
      const bug = await tx.bug.findFirst({ where: { id: bugId, tenantId: agent.tenantId, projectId, isDeleted: false }, select: { id: true, title: true, projectId: true, status: true, assigneeId: true, areaId: true, voteCount: true } });
      if (!bug) throw new IssueApiError(404, "Issue not found in this project.");
      if (bug.status !== "open") throw new IssueApiError(409, "Only open issues can be offered.");
      if (!await isConfirmed(bugId, tx)) throw new IssueApiError(409, "The issue must be confirmed before it can be offered.");
      await assertRedesignOpen(bugId, tx);
      await assertApprovalOpen(bugId, "before_offer", { db: tx, tenantId: agent.tenantId, agent });
      const current = await tx.issueClaim.findFirst({ where: { bugId, releasedAt: null } });
      if (current) {
        // The project's offer window, as the expiry sweep and accept use.
        const { offerWindowSeconds } = await workflowFor(projectId, tx);
        if (current.status === "offered" && !isOfferExpired(current.offeredAt, Date.now(), offerWindowSeconds * 1000)) {
          return { claim: current, beneficiaryUserId: current.beneficiaryUserId, bugTitle: bug.title, created: false };
        }
        if (current.status === "active") throw new IssueApiError(409, "This issue already has an active claim.");
        await tx.issueClaim.update({ where: { id: current.id }, data: { status: "released", releasedAt: new Date(), releaseReason: "expired" } });
        await publish(tx, { tenantId: agent.tenantId, type: "claim.released", actorAgentId: agent.agentId, bugId,
          payload: { claimId: current.id, issueId: bugId, reason: "expired" } });
      }
      const next = await offerNext(tx, agent, bug);
      if (!next) throw new IssueApiError(409, "No eligible person is available for this offer.");
      return { ...next, created: true };
    });
    if (result.created) {
      notifyClaimOffered({ id: result.claim.id, bugId, bugTitle: result.bugTitle, beneficiaryUserId: result.beneficiaryUserId });
      scheduleOfferExpiry(result.claim.id);
    }
    return result.claim;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new IssueApiError(409, "This issue already has an active claim or pending offer.");
    }
    throw error;
  }
}

/** Durable expiry state is checked here and again on acceptance after restarts. Returns true if expired. */
export async function expireOffer(claimId: string): Promise<boolean> {
  const result = await prisma.$transaction(async (tx) => {
    const claim = await tx.issueClaim.findUnique({ where: { id: claimId }, select: { id: true, bugId: true, status: true, offeredAt: true, releasedAt: true, agentId: true, beneficiaryUserId: true, bug: { select: { tenantId: true, id: true, title: true, projectId: true, assigneeId: true, areaId: true } } } });
    if (!claim || claim.status !== "offered" || claim.releasedAt) return null;
    const { offerWindowSeconds } = await workflowFor(claim.bug.projectId, tx);
    const offerWindowMs = offerWindowSeconds * 1000;
    if (!isOfferExpired(claim.offeredAt, Date.now(), offerWindowMs)) return null;
    await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${claim.bugId} FOR UPDATE`;
    const fresh = await tx.issueClaim.findUnique({ where: { id: claimId }, select: { id: true, bugId: true, status: true, offeredAt: true, releasedAt: true, agentId: true, beneficiaryUserId: true, bug: { select: { tenantId: true, id: true, title: true, projectId: true, assigneeId: true, areaId: true } } } });
    if (!fresh || fresh.status !== "offered" || fresh.releasedAt || !isOfferExpired(fresh.offeredAt, Date.now(), offerWindowMs)) return null;
    const now = new Date();
    await tx.issueClaim.update({ where: { id: claimId }, data: { status: "released", releasedAt: now, releaseReason: "expired" } });
    await publish(tx, { tenantId: fresh.bug.tenantId, type: "claim.released", actorAgentId: fresh.agentId, bugId: fresh.bugId,
      payload: { claimId, issueId: fresh.bugId, beneficiaryUserId: fresh.beneficiaryUserId, reason: "expired" } });
    const hasPendingBids = await (tx.issueBid?.findFirst
      ? tx.issueBid.findFirst({
          where: { bugId: fresh.bugId, withdrawnAt: null, awardedAt: null },
          select: { id: true },
        })
      : null);
    const next = hasPendingBids
      ? null
      : await offerNext(tx, { tenantId: fresh.bug.tenantId }, fresh.bug);
    return { released: true, next };
  });
  if (result) {
    if (result.next) {
      notifyClaimOffered({ id: result.next.claim.id, bugId: result.next.claim.bugId, bugTitle: result.next.bugTitle, beneficiaryUserId: result.next.beneficiaryUserId });
      scheduleOfferExpiry(result.next.claim.id);
    }
    return true;
  }
  return false;
}

/**
 * Sweeps and expires all pending offers whose TTL has elapsed (#681).
 * Durable across process restarts; safe to run from a cron or interval.
 */
export async function sweepExpiredOffers(tenantId?: string, projectId?: string): Promise<{ expired: number }> {
  // Offers in different projects can have different windows, so the decision
  // is made per candidate instead of with one global cutoff.
  const candidates = await prisma.issueClaim.findMany({
    where: {
      status: "offered",
      releasedAt: null,
      ...(tenantId || projectId
        ? {
            bug: {
              ...(tenantId ? { tenantId } : {}),
              ...(projectId ? { projectId } : {}),
            },
          }
        : {}),
    },
    select: { id: true, offeredAt: true, bug: { select: { projectId: true } } },
  });
  const now = Date.now();
  let expired = 0;
  for (const candidate of candidates) {
    const { offerWindowSeconds } = await workflowFor(candidate.bug.projectId);
    if (!isOfferExpired(candidate.offeredAt, now, offerWindowSeconds * 1000)) continue;
    const didExpire = await expireOffer(candidate.id);
    if (didExpire) expired++;
  }
  return { expired };
}

export async function acceptOffer(agent: AgentContext, claimId: string) {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const claim = await tx.issueClaim.findUnique({ where: { id: claimId }, include: { beneficiary: { select: { name: true } }, bug: { select: { id: true, title: true, status: true, assigneeId: true, tenantId: true, projectId: true, areaId: true, voteCount: true, severity: true, assignee: { select: { name: true } } } } } });
      if (!claim || claim.bug.tenantId !== agent.tenantId) throw new IssueApiError(404, "Offer not found.");
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Bug" WHERE "id" = ${claim.bugId} AND "tenantId" = ${agent.tenantId} FOR UPDATE`;
      if (!locked.length) throw new IssueApiError(404, "Offer not found.");
      await tx.$queryRaw`SELECT "id" FROM "IssueClaim" WHERE "id" = ${claimId} FOR UPDATE`;
      const fresh = await tx.issueClaim.findUnique({ where: { id: claimId }, include: { beneficiary: { select: { name: true } }, bug: { select: { id: true, title: true, status: true, assigneeId: true, tenantId: true, projectId: true, areaId: true, voteCount: true, severity: true, assignee: { select: { name: true } } } } } });
      if (!fresh || fresh.agentId !== agent.agentId) throw new IssueApiError(409, "This offer is no longer available to this agent.");
      if (fresh.status === "released" && fresh.releaseReason === "expired") throw new IssueApiError(410, "This offer expired and has been released.");
      if (fresh.status !== "offered" || fresh.releasedAt) throw new IssueApiError(409, "This offer is no longer available to this agent.");

      // Check if an active claim already exists on this bug (#662)
      const existingActive = await tx.issueClaim.findFirst({
        where: { bugId: fresh.bugId, status: "active", releasedAt: null, id: { not: fresh.id } },
      });
      if (existingActive) {
        throw new IssueApiError(409, "This issue already has an active claim.");
      }

      const now = new Date();
      const workflow = await workflowFor(fresh.bug.projectId, tx);
      if (isOfferExpired(fresh.offeredAt, now.getTime(), workflow.offerWindowSeconds * 1000)) {
        await tx.issueClaim.update({ where: { id: fresh.id }, data: { status: "released", releasedAt: now, releaseReason: "expired" } });
        await publish(tx, { tenantId: agent.tenantId, type: "claim.released", actorAgentId: agent.agentId, bugId: fresh.bugId,
          payload: { claimId: fresh.id, issueId: fresh.bugId, beneficiaryUserId: fresh.beneficiaryUserId, reason: "expired" } });
        const next = await offerNext(tx, agent, fresh.bug);
        return { expired: true as const, next, bugId: fresh.bugId };
      }
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${fresh.beneficiaryUserId} FOR UPDATE`;
      const activeClaims = await tx.issueClaim.count({ where: {
        beneficiaryUserId: fresh.beneficiaryUserId, status: "active", releasedAt: null,
        bug: { tenantId: agent.tenantId, projectId: fresh.bug.projectId, isDeleted: false },
      } });
      if (activeClaims >= workflow.maxActiveClaims) {
        await tx.issueClaim.update({ where: { id: fresh.id }, data: { status: "released", releasedAt: now, releaseReason: "capacity" } });
        await publish(tx, { tenantId: agent.tenantId, type: "claim.released", actorAgentId: agent.agentId, bugId: fresh.bugId,
          payload: { claimId: fresh.id, issueId: fresh.bugId, beneficiaryUserId: fresh.beneficiaryUserId, reason: "capacity" } });
        const next = await offerNext(tx, agent, fresh.bug);
        return { unavailable: true as const, next, bugId: fresh.bugId };
      }
      if (fresh.bug.status !== "open" || !canAssignTicket({ actorId: fresh.beneficiaryUserId, actorRole: "user", currentAssigneeId: fresh.bug.assigneeId, targetAssigneeId: fresh.beneficiaryUserId, claimed: true })) {
        await tx.issueClaim.update({ where: { id: fresh.id }, data: { status: "released", releasedAt: now, releaseReason: "unavailable" } });
        await publish(tx, { tenantId: agent.tenantId, type: "claim.released", actorAgentId: agent.agentId, bugId: fresh.bugId,
          payload: { claimId: fresh.id, issueId: fresh.bugId, beneficiaryUserId: fresh.beneficiaryUserId, reason: "unavailable" } });
        return { unavailable: true as const };
      }
      const deliverBy = deliveryDeadline(now, deliveryWindowMinutes(fresh.bug.severity, workflow.deliveryMinutes));
      await tx.issueClaim.update({ where: { id: fresh.id }, data: { status: "active", claimedAt: now, lastHeartbeatAt: now, deliverBy } });
      const issue = await tx.bug.update({ where: { id: fresh.bugId }, data: { assigneeId: fresh.beneficiaryUserId, status: "in_progress" }, select: { id: true, assigneeId: true, status: true } });
      await tx.bugActivity.createMany({ data: [
        ...(fresh.bug.assigneeId !== fresh.beneficiaryUserId ? [{ bugId: fresh.bugId, actorId: fresh.beneficiaryUserId, type: "assignee_changed" as const, summary: assigneeChangedSummary(fresh.bug.assignee?.name ?? null, fresh.beneficiary.name), metadata: { field: "assignee", from: fresh.bug.assigneeId, to: fresh.beneficiaryUserId } }] : []),
        { bugId: fresh.bugId, actorId: fresh.beneficiaryUserId, type: "status_changed", summary: statusChangedSummary("open", "in_progress"), metadata: { field: "status", from: "open", to: "in_progress" } },
      ] });
      await ensureWatching(tx, fresh.bugId, [fresh.beneficiaryUserId]);
      await publish(tx, { tenantId: agent.tenantId, type: "claim.accepted", actorAgentId: agent.agentId, bugId: fresh.bugId,
        payload: { claimId: fresh.id, issueId: fresh.bugId, projectId: fresh.bug.projectId, beneficiaryUserId: fresh.beneficiaryUserId } });
      return { expired: false as const, claim: { ...fresh, status: "active", claimedAt: now, deliverBy }, issue };
    }, { maxWait: 10000, timeout: 15000 });
    if ("expired" in result && result.expired) {
      if (result.next) {
        notifyClaimOffered({ id: result.next.claim.id, bugId: result.bugId, bugTitle: result.next.bugTitle, beneficiaryUserId: result.next.beneficiaryUserId });
        scheduleOfferExpiry(result.next.claim.id);
      }
      throw new IssueApiError(410, "This offer expired and has been released.");
    }
    if ("unavailable" in result) {
      if ("next" in result && result.next) {
        notifyClaimOffered({ id: result.next.claim.id, bugId: result.bugId, bugTitle: result.next.bugTitle, beneficiaryUserId: result.next.beneficiaryUserId });
        scheduleOfferExpiry(result.next.claim.id);
      }
      throw new IssueApiError(409, "The issue can no longer be assigned to this person.");
    }
    return result;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new IssueApiError(409, "This issue already has an active claim.");
    }
    throw error;
  }
}

export const releaseSchema = z.object({
  projectId: id.optional(),
  /** Why the agent is giving the work back, shown in the audit log. */
  reason: z.string().trim().max(500).optional(),
}).strict();

/**
 * An agent gives back an issue it holds (#547): declines a pending offer, or
 * releases an active claim it can't finish. Either way the issue goes to the
 * next person, without waiting for an offer to expire or a heartbeat to lapse.
 *
 * - Only the agent holding the offer or claim can release it.
 * - releaseReason is "declined" for an offer and "agent" for an active claim.
 *   Neither counts as a silence release, so giving work back promptly is never
 *   penalised the way going quiet is.
 * - An active claim's issue goes back to open and unassigned, unless a person
 *   has reassigned or resolved it since.
 * - The issue is then offered to someone else (never straight back to the
 *   same person), if it is still open and confirmed.
 */
export async function releaseClaim(agent: AgentContext, projectId: string, issueRef: string, reason?: string) {
  const result = await prisma.$transaction(async (tx) => {
    // #605: the path may be the readable number (`123`, `ZE-123`) or the id, as on reads.
    const ref = parseIssueRef(issueRef);
    const bugId = ref.kind === "id" ? ref.id : (await resolveIssueRef(tx, ref, { tenantId: agent.tenantId }))?.id;
    if (!bugId) throw new IssueApiError(404, "Issue not found in this project.");
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Bug" WHERE "id" = ${bugId} AND "tenantId" = ${agent.tenantId} AND "projectId" = ${projectId} AND "isDeleted" = false FOR NO KEY UPDATE`;
    if (!locked.length) throw new IssueApiError(404, "Issue not found in this project.");
    const claim = await tx.issueClaim.findFirst({
      where: { bugId, agentId: agent.agentId, releasedAt: null, status: { in: ["offered", "active"] } },
      include: { beneficiary: { select: { name: true } } },
    });
    if (!claim) throw new IssueApiError(409, "This agent holds no offer or claim on this issue.");
    const now = new Date();
    const releaseReason = claim.status === "offered" ? "declined" : "agent";
    await tx.issueClaim.update({ where: { id: claim.id }, data: { status: "released", releasedAt: now, releaseReason } });

    const bug = await tx.bug.findFirstOrThrow({
      where: { id: bugId },
      select: { id: true, title: true, status: true, assigneeId: true, projectId: true, areaId: true },
    });
    let reopened = false;
    if (claim.status === "active") {
      const otherOpen = await tx.issueClaim.count({ where: { bugId, releasedAt: null, id: { not: claim.id } } });
      if (!otherOpen && bug.status === "in_progress" && bug.assigneeId === claim.beneficiaryUserId) {
        await tx.bug.update({ where: { id: bugId }, data: { assigneeId: null, status: "open" } });
        await tx.bugActivity.createMany({ data: [
          { bugId, actorId: claim.beneficiaryUserId, type: "assignee_changed", summary: assigneeChangedSummary(claim.beneficiary.name, null), metadata: { field: "assignee", from: claim.beneficiaryUserId, to: null } },
          { bugId, actorId: claim.beneficiaryUserId, type: "status_changed", summary: statusChangedSummary("in_progress", "open"), metadata: { field: "status", from: "in_progress", to: "open" } },
        ] });
        reopened = true;
      }
    }
    await publish(tx, { tenantId: agent.tenantId, type: "claim.released", actorAgentId: agent.agentId, bugId,
      payload: { claimId: claim.id, issueId: bugId, beneficiaryUserId: claim.beneficiaryUserId, reason: releaseReason, ...(reason ? { note: reason } : {}) } });

    const stillOpen = claim.status === "offered" ? bug.status === "open" : reopened;
    const next = stillOpen && (await isConfirmed(bugId, tx))
      ? await offerNext(tx, agent, { ...bug, assigneeId: null }, [claim.beneficiaryUserId])
      : null;
    return {
      released: { claimId: claim.id, issueId: bugId, reason: releaseReason, reopened: claim.status === "active" ? reopened : false },
      next,
    };
  }, { maxWait: 10000, timeout: 15000 });
  if (result.next) {
    notifyClaimOffered({ id: result.next.claim.id, bugId: result.released.issueId, bugTitle: result.next.bugTitle, beneficiaryUserId: result.next.beneficiaryUserId });
    scheduleOfferExpiry(result.next.claim.id);
  }
  return { ...result.released, reofferedTo: result.next?.beneficiaryUserId ?? null };
}
