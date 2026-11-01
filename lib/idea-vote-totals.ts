import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/** An idea's verdict votes by opinion, weighted as its score counts them (a manager agent's up to managerVoteWeight). */
export type IdeaVoteTotals = { good: number; bad: number; neutral: number };

export const NO_VOTES: IdeaVoteTotals = { good: 0, bad: 0, neutral: 0 };

/**
 * The weighted good, bad and neutral votes on each idea (#724), from one
 * grouped read: the numbers the idea page, the Ideas lists and the agent API
 * all show. An idea with no verdicts is all zeros.
 */
export async function ideaVoteTotals(db: Db, ideaIds: string[]): Promise<Map<string, IdeaVoteTotals>> {
  const totals = new Map<string, IdeaVoteTotals>(ideaIds.map((id) => [id, { ...NO_VOTES }]));
  if (!ideaIds.length) return totals;
  const rows = await db.ideaVerdict.groupBy({
    by: ["ideaId", "opinion"],
    where: { ideaId: { in: ideaIds } },
    _sum: { votes: true },
  });
  for (const row of rows) {
    const entry = totals.get(row.ideaId) ?? { ...NO_VOTES };
    entry[row.opinion] += row._sum.votes ?? 0;
    totals.set(row.ideaId, entry);
  }
  return totals;
}
