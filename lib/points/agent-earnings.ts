import type { Prisma, PrismaClient } from "@prisma/client";
import { pointsNumber } from "@/lib/points/rules";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Lifetime points each agent earned in a tenant (#710): the sum of the point
 * entries its work wrote, corrections included (they carry the same agent).
 * Every entry is confirmed: Ziki writes points only once the work is
 * accepted, so there is no pending amount. Entries a person earned with no
 * agent, and entries written before agents were recorded, belong to no agent.
 * An agent with none is 0.
 */
export async function agentEarnings(db: Db, tenantId: string, agentIds: string[]): Promise<Map<string, number>> {
  const earned = new Map<string, number>(agentIds.map((id) => [id, 0]));
  if (!agentIds.length) return earned;
  const rows = await db.pointEntry.groupBy({
    by: ["agentId"],
    where: { tenantId, agentId: { in: agentIds } },
    _sum: { points: true },
  });
  for (const row of rows) if (row.agentId) earned.set(row.agentId, pointsNumber(row._sum.points));
  return earned;
}
