import { prisma } from "@/lib/prisma";

/**
 * #importance: one agent's reason for marking an issue important, as the
 * issue page lists it under the importance count. A person's own click has no
 * reason and is not listed here; the avatars show who marked it.
 */
export type ImportanceReason = {
  id: string;
  /** The person the mark counts for: the agent's owner. */
  userName: string;
  agentName: string | null;
  /** What the mark counts as: 1, or 5 from a manager or merger agent. */
  weight: number;
  summary: string;
  description: string | null;
  updatedAt: Date;
};

type ReasonRow = {
  id: string;
  value: number;
  summary: string | null;
  description: string | null;
  updatedAt: Date;
  user: { name: string | null };
  agent: { name: string } | null;
};

export function toImportanceReasons(rows: ReasonRow[]): ImportanceReason[] {
  return rows
    .filter((row): row is ReasonRow & { summary: string } => Boolean(row.summary?.trim()) && row.value > 0)
    .map((row) => ({
      id: row.id,
      userName: row.user.name?.trim() || "A member",
      agentName: row.agent?.name ?? null,
      weight: row.value,
      summary: row.summary,
      description: row.description,
      updatedAt: row.updatedAt,
    }));
}

/** The marks on an issue that carry a reason, newest first. */
export async function fetchImportanceReasons(bugId: string): Promise<ImportanceReason[]> {
  const rows = await prisma.vote.findMany({
    where: { bugId, summary: { not: null }, value: { gt: 0 } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 50,
    select: {
      id: true,
      value: true,
      summary: true,
      description: true,
      updatedAt: true,
      user: { select: { name: true } },
      agent: { select: { name: true } },
    },
  });
  return toImportanceReasons(rows);
}
