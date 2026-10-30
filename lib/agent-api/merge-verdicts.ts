import { reviewerConflict, reviewerCreditConflict, type ReviewedBug } from "@/lib/agents/independence";

export type CountableVerdict = {
  headSha?: string | null;
  onBehalfOfUserId: string;
  agent: { id: string; ownerUserId: string };
};

export type VerdictClaim = { agentId: string; agent: { ownerUserId: string } } | null;

type ClaimRow = { status: string; claimedAt?: Date | null; releasedAt: Date | null };

/**
 * The claim the fix was delivered under (#432): the active one, or, once a
 * pull request is linked, the last claim let go after delivery. A delivered fix
 * stays where it got to when its agent lets go (#one-status), so its testing,
 * review, merge and points still follow that claim. Pass claims with
 * `claimedAt` selected.
 */
export function deliveredClaim<C extends ClaimRow>(bug: { pullRequestUrl: string | null; claims: readonly C[] }): C | null {
  const active = bug.claims.find((c) => c.status === "active" && !c.releasedAt);
  if (active || !bug.pullRequestUrl) return active ?? null;
  const released = bug.claims
    .filter((c) => c.status === "released" && c.claimedAt && c.releasedAt)
    .sort((a, b) => b.releasedAt!.getTime() - a.releasedAt!.getTime());
  return released[0] ?? null;
}

/**
 * The good-to-merge verdicts that count toward accepting a fix (#434): one per
 * independent owner, never from the claim holder's agent or owner, and never
 * from anyone the independence rules exclude. The merge gate and the merge
 * queue both use this, so a fix the queue lists as ready is one the gate
 * accepts. Pass only verdicts on the linked pull request (#526), oldest first:
 * the last counted one names the commit that may merge (#489).
 */
export function countedMergeVerdicts(
  verdicts: readonly CountableVerdict[],
  claim: VerdictClaim,
  reviewed: ReviewedBug,
  fallbackHeadSha: string | null = null,
): { reviewers: string[]; acceptedHeadSha: string | null } {
  const owners = new Set<string>();
  const reviewers: string[] = [];
  let acceptedHeadSha = fallbackHeadSha;
  for (const verdict of verdicts) {
    if (claim && (verdict.agent.id === claim.agentId || verdict.agent.ownerUserId === claim.agent.ownerUserId)) continue;
    if (reviewerConflict({ id: verdict.agent.id, ownerUserId: verdict.agent.ownerUserId }, reviewed)) continue;
    if (reviewerCreditConflict(verdict.onBehalfOfUserId, reviewed)) continue;
    if (owners.has(verdict.agent.ownerUserId)) continue;
    owners.add(verdict.agent.ownerUserId);
    reviewers.push(verdict.onBehalfOfUserId);
    if (verdict.headSha) acceptedHeadSha = verdict.headSha;
  }
  return { reviewers, acceptedHeadSha };
}
