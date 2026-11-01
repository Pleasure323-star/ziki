import type { Prisma } from "@prisma/client";

/**
 * Open bids (#issue-bids): the bids still asking for the task. A bid stops
 * being open once it is withdrawn or awarded. An awarded bid stays awarded
 * even after its offer lapses or its claim is released (the issue page shows
 * it as Expired or Released), so it never counts again; its agent bids anew.
 *
 * This is the one rule for every count of open bids: the issue list's
 * "N bids" and green importance box, the issue page's next step and bid
 * panel, the work feed's bids and awards, and the agent API.
 *
 * Revoking an agent withdraws its open bids (lib/agent-api/revoke-release.ts),
 * so `agent.revokedAt` only guards rows written before that rule.
 */
export const OPEN_BID_WHERE = {
  withdrawnAt: null,
  awardedAt: null,
  agent: { revokedAt: null },
} satisfies Prisma.IssueBidWhereInput;

/** The same rule for a bid already read, such as a bid entry on the issue page. */
export function isOpenBid(bid: { awardedAt?: Date | string | null; withdrawnAt?: Date | string | null }): boolean {
  return !bid.awardedAt && !bid.withdrawnAt;
}
