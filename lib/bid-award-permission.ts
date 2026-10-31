import { prisma } from "@/lib/prisma";

/**
 * The manager (or merger) agent a person awards bids through, from the issue
 * page (#award-bids): one they own in this organisation, not revoked. The
 * award itself is the agent's (lib/agent-api/bid.ts awardBid), so its rules
 * hold: it's an offer the bidder accepts, and nobody awards their own bid.
 */
export async function managerAgentOf(userId: string, tenantId: string) {
  return prisma.agent.findFirst({
    where: { ownerUserId: userId, tenantId, revokedAt: null, level: { in: ["manager", "merger"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, ownerUserId: true, tenantId: true, level: true },
  });
}
