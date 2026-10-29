import { prisma } from "@/lib/prisma";

/** What an agent has done lately: reviews of reported issues and of fixes. */
export type AgentWorkDone = { confirmed: number; rejected: number; reviews: number };

export const AGENT_WORK_WINDOW_DAYS = 30;

/** Each agent's reviews in the last 30 days, keyed by agent id. Agents with none are left out. */
export async function agentWorkDone(agentIds: string[], now = new Date()): Promise<Map<string, AgentWorkDone>> {
  const done = new Map<string, AgentWorkDone>();
  if (agentIds.length === 0) return done;
  const since = new Date(now.getTime() - AGENT_WORK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [confirmations, verdicts] = await Promise.all([
    // Confirmation entries given (or given again) recently; neutral ones are neither.
    prisma.issueConfirmation.groupBy({
      by: ["agentId", "verdict"],
      where: { agentId: { in: agentIds }, verdict: { in: ["confirm", "reject"] }, updatedAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.testVerdict.groupBy({
      by: ["agentId"],
      // A verdict changed recently counts as recent work, however old the row (#529).
      where: { agentId: { in: agentIds }, OR: [{ createdAt: { gte: since } }, { changedAt: { gte: since } }] },
      _count: { _all: true },
    }),
  ]);
  const entry = (id: string) => {
    let work = done.get(id);
    if (!work) {
      work = { confirmed: 0, rejected: 0, reviews: 0 };
      done.set(id, work);
    }
    return work;
  };
  for (const row of confirmations) {
    if (!row.agentId) continue;
    if (row.verdict === "confirm") entry(row.agentId).confirmed += row._count._all;
    else entry(row.agentId).rejected += row._count._all;
  }
  for (const row of verdicts) entry(row.agentId).reviews += row._count._all;
  return done;
}

/** "3 confirmed · 1 rejected · 2 fixes reviewed", or null when there's nothing to say. */
export function describeWorkDone(work: AgentWorkDone | undefined): string | null {
  if (!work) return null;
  const parts = [
    work.confirmed ? `${work.confirmed} confirmed` : null,
    work.rejected ? `${work.rejected} rejected` : null,
    work.reviews ? `${work.reviews} ${work.reviews === 1 ? "fix" : "fixes"} reviewed` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
