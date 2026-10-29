import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { requireLevel } from "@/lib/agents/levels";
import { IssueApiError } from "@/lib/agent-api/errors";
import { isConfirmed } from "@/lib/agent-api/confirmations";
import { publish } from "@/lib/agent-api/events";
import { acceptOffer, isOfferExpired, scheduleOfferExpiry } from "@/lib/agent-api/offer";
import { notifyClaimOffered } from "@/lib/agent-notifications";
import { assertRedesignOpen } from "@/lib/redesigns";
import { assertApprovalOpen } from "@/lib/approvals";
import { workflowFor } from "@/lib/workflow";
import { parseIssueRef, resolveIssueRef } from "@/lib/issue-ref";

const id = z.string().trim().min(1).max(191);

/**
 * `agentId` is the agent to give the issue to, or `"self"` for the calling
 * manager agent. `mode` is `offer` (the default: a normal, time-limited offer)
 * or `direct` (the claim starts at once).
 */
export const assignSchema = z.object({
  projectId: id.optional(),
  agentId: id,
  mode: z.enum(["offer", "direct"]).default("offer"),
}).strict();

export type AssignInput = z.infer<typeof assignSchema>;

/**
 * A manager or merger agent gives a ready issue to an agent it chooses, or to
 * itself (#715). The issue must be open, converted and confirmed, with no
 * active claim or live offer; the target must be an active agent in the
 * tenant whose owner is under the project's active-claim cap. The same gates
 * as `offerIssue` apply. Assigning to someone else credits the manager's owner
 * as dispatcher; assigning to self does not.
 */
export async function assignIssue(manager: AgentContext, projectId: string, issueRef: string, input: AssignInput) {
  requireLevel(manager, "manager");
  const self = input.agentId === "self" || input.agentId === manager.agentId;

  try {
    const offered = await prisma.$transaction(async (tx) => {
      const ref = parseIssueRef(issueRef);
      const resolved = ref.kind === "id" ? { id: ref.id } : await resolveIssueRef(tx, ref, { tenantId: manager.tenantId });
      if (!resolved) throw new IssueApiError(404, "Issue not found in this project.");
      const bugId = resolved.id;
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Bug" WHERE "id" = ${bugId} AND "tenantId" = ${manager.tenantId} AND "projectId" = ${projectId} AND "isDeleted" = false FOR UPDATE`;
      if (!locked.length) throw new IssueApiError(404, "Issue not found in this project.");
      const bug = await tx.bug.findFirst({ where: { id: bugId }, select: { id: true, title: true, status: true, assigneeId: true } });
      if (!bug) throw new IssueApiError(404, "Issue not found in this project.");
      if (bug.status !== "open") throw new IssueApiError(409, "Only open issues can be assigned.");
      if (!await isConfirmed(bugId, tx)) throw new IssueApiError(409, "The issue must be confirmed before it can be assigned.");
      await assertRedesignOpen(bugId, tx);
      await assertApprovalOpen(bugId, "before_offer", { db: tx, tenantId: manager.tenantId, agent: manager });

      const target = await tx.agent.findFirst({
        where: { id: self ? manager.agentId : input.agentId, tenantId: manager.tenantId, revokedAt: null },
        select: { id: true, ownerUserId: true },
      });
      if (!target) throw new IssueApiError(404, "Agent not found in this organisation.");
      if (bug.assigneeId && bug.assigneeId !== target.ownerUserId) {
        throw new IssueApiError(409, "The issue is assigned to someone else.");
      }

      const workflow = await workflowFor(projectId, tx);
      const current = await tx.issueClaim.findFirst({ where: { bugId, releasedAt: null } });
      if (current?.status === "active") throw new IssueApiError(409, "This issue already has an active claim.");
      if (current?.status === "offered" && !isOfferExpired(current.offeredAt, Date.now(), workflow.offerWindowSeconds * 1000)) {
        throw new IssueApiError(409, "This issue already has a pending offer.");
      }
      if (current) {
        await tx.issueClaim.update({ where: { id: current.id }, data: { status: "released", releasedAt: new Date(), releaseReason: "expired" } });
        await publish(tx, { tenantId: manager.tenantId, type: "claim.released", actorAgentId: manager.agentId, bugId, payload: { claimId: current.id, issueId: bugId, reason: "expired" } });
      }

      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${target.ownerUserId} FOR NO KEY UPDATE`;
      const activeClaims = await tx.issueClaim.count({ where: {
        beneficiaryUserId: target.ownerUserId, status: "active", releasedAt: null,
        bug: { tenantId: manager.tenantId, projectId, isDeleted: false },
      } });
      if (activeClaims >= workflow.maxActiveClaims) {
        throw new IssueApiError(409, `That agent's owner already holds ${activeClaims} active claims, the project's limit.`);
      }

      const claim = await tx.issueClaim.create({ data: {
        bugId, beneficiaryUserId: target.ownerUserId, agentId: target.id, status: "offered", offeredAt: new Date(),
        // A manager handing work to someone else is its dispatcher; taking it itself is not.
        ...(self ? {} : { dispatcherUserId: manager.ownerId }),
      } });
      await publish(tx, { tenantId: manager.tenantId, type: "claim.offered", actorAgentId: manager.agentId, bugId,
        payload: {
          claimId: claim.id, issueId: bugId, projectId, beneficiaryUserId: target.ownerUserId,
          assignedByAgentId: manager.agentId, mode: input.mode,
          expiresAt: new Date(claim.offeredAt!.getTime() + workflow.offerWindowSeconds * 1000).toISOString(),
        } });
      return { claim, bugId, bugTitle: bug.title, target };
    });

    if (input.mode === "offer") {
      notifyClaimOffered({ id: offered.claim.id, bugId: offered.bugId, bugTitle: offered.bugTitle, beneficiaryUserId: offered.target.ownerUserId });
      scheduleOfferExpiry(offered.claim.id);
      return { mode: "offer" as const, claim: offered.claim };
    }

    // Direct: accept the offer as the target agent, so the claim starts under
    // exactly the rules an agent's own accept follows (deadline, activity, cap).
    const asTarget: AgentContext = self
      ? manager
      : { ...manager, agentId: offered.target.id, ownerId: offered.target.ownerUserId, level: "working", keyId: "assign" };
    const accepted = await acceptOffer(asTarget, offered.claim.id);
    return { mode: "direct" as const, claim: accepted.claim };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new IssueApiError(409, "This issue already has an active claim or pending offer.");
    }
    throw error;
  }
}
