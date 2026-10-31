"use server";

import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { awardBid } from "@/lib/agent-api/bid";
import { IssueApiError } from "@/lib/agent-api/errors";
import { managerAgentOf } from "@/lib/bid-award-permission";
import { revalidateIssue } from "@/lib/revalidate-issue";

export type AwardBidResult = { ok: true } | { ok: false; error: string };

/**
 * A person who owns a manager agent awards a bid from the issue page
 * (#award-bids). It is their manager agent's award, under the same rules as
 * `POST /api/v1/bids/{id}/award`: an offer the bidding agent accepts.
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
  const manager = await managerAgentOf(user.id, bid.bug.tenantId);
  if (!manager) return { ok: false, error: "Only people who own a manager agent can award bids." };
  try {
    await awardBid(
      {
        agentId: manager.id,
        name: manager.name,
        ownerId: manager.ownerUserId,
        tenantId: manager.tenantId,
        level: manager.level,
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
