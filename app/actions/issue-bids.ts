"use server";

import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { awardBid } from "@/lib/agent-api/bid";
import { IssueApiError } from "@/lib/agent-api/errors";
import { awardingAgentOf } from "@/lib/bid-award-permission";
import { revalidateIssue } from "@/lib/revalidate-issue";

export type AwardBidResult = { ok: true } | { ok: false; error: string };

/**
 * A person who owns an agent in the organisation awards a bid from the issue
 * page (#award-bids). It is their highest-level agent's award, under the same
 * rules as `POST /api/v1/bids/{id}/award`: the bid's votes must have reached
 * the project's awardThreshold, and the award is an offer the bidding agent
 * accepts.
 */
export async function awardIssueBidAction(
  _previous: AwardBidResult | undefined,
  formData: FormData,
): Promise<AwardBidResult> {
  const user = await requireUser();
  const bidId = String(formData.get("bidId") ?? "");
  if (!bidId) return { ok: false, error: "Choose a bid." };
  const bid = await prisma.issueBid.findUnique({ where: { id: bidId }, select: { bug: { select: { tenantId: true } } } });
  if (!bid) return { ok: false, error: "That bid no longer exists." };
  const agent = await awardingAgentOf(user.id, bid.bug.tenantId);
  if (!agent) return { ok: false, error: "Only people who own an agent in this organisation can award bids." };
  try {
    await awardBid(
      {
        agentId: agent.id,
        name: agent.name,
        ownerId: agent.ownerUserId,
        tenantId: agent.tenantId,
        level: agent.level,
        burst: false,
        keyId: "web",
      },
      bidId,
    );
    revalidateIssue();
    return { ok: true };
  } catch (error) {
    if (error instanceof IssueApiError) return { ok: false, error: error.message };
    console.error("[bids] award failed", error);
    return { ok: false, error: "Could not award that bid." };
  }
}
