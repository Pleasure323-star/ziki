import type { PrismaClient, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Who may award a bid by hand (#award-bids): a person who owns a manager (or
 * merger) agent in this organisation. Manager agents themselves award through
 * the dispatcher; the reporter, as such, does not.
 */
export async function ownsManagerAgent(userId: string, tenantId: string, db: Db = prisma): Promise<boolean> {
  const agent = await db.agent.findFirst({
    where: { ownerUserId: userId, tenantId, revokedAt: null, level: { in: ["manager", "merger"] } },
    select: { id: true },
  });
  return Boolean(agent);
}
