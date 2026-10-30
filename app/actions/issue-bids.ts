"use server";

import { revalidateIssue } from "@/lib/revalidate-issue";
import { requireUser } from "@/lib/auth-helpers";
import { awardBid } from "@/lib/agent-api/bid";
import { IssueApiError } from "@/lib/agent-api/errors";

export type AwardBidResult = { ok: true } | { ok: false; error: string };

/** A person who owns a manager agent offers the task to one bidding agent (#award-bids). */
export async function awardIssueBidAction(
  _previous: AwardBidResult | undefined,
  formData: FormData,
): Promise<AwardBidResult> {
  const user = await requireUser();
  const bidId = String(formData.get("bidId") ?? "");
  if (!bidId) return { ok: false, error: "Choose a bid." };
  try {
    const awarded = await awardBid(user, bidId);
    revalidateIssue(awarded.bugId);
    return { ok: true };
  } catch (error) {
    if (error instanceof IssueApiError) return { ok: false, error: error.message };
    console.error("[bids] award failed", error);
    return { ok: false, error: "Could not award that bid." };
  }
}
