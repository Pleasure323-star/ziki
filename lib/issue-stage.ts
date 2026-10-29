import type { Prisma, PrismaClient } from "@prisma/client";
import { reviewerConflict, reviewerCreditConflict, type ReviewedBug } from "@/lib/agents/independence";
import { workflowFor } from "@/lib/workflow";
import { DEFAULT_PROJECT_WORKFLOW } from "@/lib/workflow-config";

/**
 * Where an open issue sits before someone starts the work. Not a status.
 * Ideas are not issues (#idea-table): they live in their own table and have
 * no stage here.
 *
 * - `confirming`: converted from an idea, waiting for independent people
 *   to confirm it is real and not a duplicate.
 * - `ready`: a confirmed issue, so it can be passed on.
 */
export type IssueStage = "confirming" | "ready";

/** List filters. `ready` is the issue that can be passed on. */
export type IssueStageView = IssueStage;

export const issueStageLabels: Record<IssueStage, string> = {
  confirming: "Requires confirmation",
  ready: "Ready",
};

/** `?stage=` values. */
export function parseIssueStageView(raw: string | null | undefined): IssueStageView | null {
  return raw === "confirming" || raw === "ready" ? raw : null;
}

/** The stage of an open issue. Anything no longer open has no stage. */
export function issueStage(input: { status: string }): IssueStage | null {
  // #requires-confirmation: the stage follows the status. Requires
  // confirmation is a status of its own; an Open issue was confirmed.
  if (input.status === "requires_confirmation") return "confirming";
  return input.status === "open" ? "ready" : null;
}

/** A confirmation entry, as the confirmed rule reads it (#issue-confirmations). */
export type ConfirmationEntry = {
  id: string;
  verdict: "confirm" | "reject" | "neutral";
  duplicateOfId: string | null;
  /** When it was last given. */
  updatedAt: Date;
  undoneAt?: Date | null;
  /** The agent that gave it; null for a person in the web app. */
  agentId: string | null;
  /** The agent's owner; null for a person. */
  agentOwnerUserId: string | null;
  onBehalfOfUserId: string;
};

/** What the rule needs about the issue. */
export type ConfirmationBug = ReviewedBug & { createdByAgentId: string | null };

/**
 * The entries that count on an issue, oldest first: given after its latest
 * edit, not undone, not by the agent that filed it, and from someone
 * independent of it (lib/agents/independence.ts) — people too, so the reporter
 * or the person it is for cannot confirm their own issue. One per owner and
 * verdict: a second agent of the same person adds nothing.
 */
export function countedConfirmationEntries(
  entries: readonly ConfirmationEntry[],
  bug: ConfirmationBug,
  revisedAt: Date | null,
): ConfirmationEntry[] {
  const seen = new Set<string>();
  const counted: ConfirmationEntry[] = [];
  const ordered = [...entries].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id));
  for (const entry of ordered) {
    if (entry.undoneAt) continue;
    if (revisedAt && entry.updatedAt <= revisedAt) continue;
    if (entry.agentId && entry.agentId === bug.createdByAgentId) continue;
    const owner = entry.agentOwnerUserId ?? entry.onBehalfOfUserId;
    if (reviewerConflict({ id: entry.agentId ?? "person", ownerUserId: owner }, bug)) continue;
    if (reviewerCreditConflict(entry.onBehalfOfUserId, bug)) continue;
    const key = `${entry.verdict}:${owner}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counted.push(entry);
  }
  return counted;
}

/** The people credited for the confirms that count, oldest first. */
export function confirmersOf(counted: readonly ConfirmationEntry[]): string[] {
  return counted.filter((entry) => entry.verdict === "confirm").map((entry) => entry.onBehalfOfUserId);
}

/** A counted reject naming another issue marks this one a duplicate. */
export function markedDuplicate(counted: readonly ConfirmationEntry[]): boolean {
  return counted.some((entry) => entry.verdict === "reject" && Boolean(entry.duplicateOfId));
}

export function isConfirmedCount(
  count: number,
  needed = DEFAULT_PROJECT_WORKFLOW.confirmationsNeeded,
): boolean {
  return count >= needed;
}

/** Where an open issue stands on confirmation, from one bulk read (#714). */
export type ConfirmationState = {
  stage: IssueStage;
  /** Distinct independent people who confirmed it. */
  accepts: number;
  /** Distinct independent people who rejected it. */
  rejects: number;
  /** The project's `confirmationsNeeded`. */
  needed: number;
};

export type ReadConfirmation = Omit<ConfirmationState, "stage"> & {
  status: string;
  confirmed: boolean;
  /** A counted reject marked it a duplicate of another issue. */
  duplicate: boolean;
  /** The people credited for the counted confirms, oldest first. */
  confirmers: string[];
  /** The entries that count, oldest first. */
  counted: ConfirmationEntry[];
};

type Db = PrismaClient | Prisma.TransactionClient;

type OptionalDelegates = {
  bug?: { findMany?: unknown };
  bugRevision?: { findMany?: unknown };
  issueConfirmation?: { findMany?: unknown };
};

/**
 * Confirmation state of every issue matching `where`, in a fixed number of
 * queries. This is the one place "confirmed" is decided — for `isConfirmed()`,
 * lists, the work feed and the merge queue: the project's
 * `confirmationsNeeded` distinct independent people confirmed it, each
 * counted only after the latest edit and unless undone (#issue-confirmations).
 * Confirming means real and not a duplicate, so there is no separate
 * duplicate clearance. Neutral counts for nothing.
 */
export async function readConfirmations(
  db: Db,
  where: Prisma.BugWhereInput,
): Promise<Map<string, ReadConfirmation>> {
  const result = new Map<string, ReadConfirmation>();
  const delegates = db as unknown as OptionalDelegates;
  if (typeof delegates.bug?.findMany !== "function" || typeof delegates.issueConfirmation?.findMany !== "function") return result;
  const bugs = await db.bug.findMany({
    where,
    select: {
      id: true,
      projectId: true,
      status: true,
      beneficiaryUserId: true,
      reporterId: true,
      createdByAgentId: true,
      createdByAgent: { select: { ownerUserId: true } },
    },
  });
  if (!bugs?.length) return result;

  const ids = bugs.map((bug) => bug.id);
  const projectIds = [...new Set(bugs.map((bug) => bug.projectId))];
  const workflows = new Map(
    await Promise.all(projectIds.map(async (projectId) => [projectId, await workflowFor(projectId, db)] as const)),
  );
  const [revisions, rows] = await Promise.all([
    typeof delegates.bugRevision?.findMany === "function"
      ? db.bugRevision.findMany({ where: { bugId: { in: ids } }, select: { bugId: true, editedAt: true } })
      : Promise.resolve([] as { bugId: string; editedAt: Date }[]),
    db.issueConfirmation.findMany({
      where: { bugId: { in: ids }, verdict: { in: ["confirm", "reject"] }, undoneAt: null },
      select: {
        id: true,
        bugId: true,
        verdict: true,
        duplicateOfId: true,
        updatedAt: true,
        agentId: true,
        onBehalfOfUserId: true,
        agent: { select: { ownerUserId: true } },
      },
    }),
  ]);

  const revisedAt = new Map<string, Date>();
  for (const revision of revisions ?? []) {
    const current = revisedAt.get(revision.bugId);
    if (!current || revision.editedAt > current) revisedAt.set(revision.bugId, revision.editedAt);
  }
  const entriesByBug = new Map<string, ConfirmationEntry[]>();
  for (const row of rows ?? []) {
    const list = entriesByBug.get(row.bugId) ?? [];
    list.push({
      id: row.id,
      verdict: row.verdict,
      duplicateOfId: row.duplicateOfId,
      updatedAt: row.updatedAt,
      agentId: row.agentId,
      agentOwnerUserId: row.agent?.ownerUserId ?? null,
      onBehalfOfUserId: row.onBehalfOfUserId,
    });
    entriesByBug.set(row.bugId, list);
  }

  for (const bug of bugs) {
    // A later assignee or claim must not undo an entry that was independent
    // when it was given (#579): those are checked when it is given.
    const reviewed: ConfirmationBug = {
      beneficiaryUserId: bug.beneficiaryUserId,
      reporterId: bug.reporterId,
      assigneeId: null,
      createdByAgent: bug.createdByAgent,
      createdByAgentId: bug.createdByAgentId,
      claims: [],
    };
    const counted = countedConfirmationEntries(entriesByBug.get(bug.id) ?? [], reviewed, revisedAt.get(bug.id) ?? null);
    const confirmers = confirmersOf(counted);
    const rejects = counted.filter((entry) => entry.verdict === "reject").length;
    const needed = workflows.get(bug.projectId)?.confirmationsNeeded ?? DEFAULT_PROJECT_WORKFLOW.confirmationsNeeded;
    result.set(bug.id, {
      status: bug.status,
      confirmed: isConfirmedCount(confirmers.length, needed),
      accepts: confirmers.length,
      rejects,
      needed,
      duplicate: markedDuplicate(counted),
      confirmers,
      counted,
    });
  }
  return result;
}

/**
 * Stage and confirmation state of every open issue matching `where`, from one
 * bulk read (see `readConfirmations`).
 */
export async function openIssueConfirmations(
  db: Db,
  where: Prisma.BugWhereInput,
): Promise<Map<string, ConfirmationState>> {
  const read = await readConfirmations(db, { ...where, status: { in: ["requires_confirmation", "open"] }, isDeleted: false });
  const result = new Map<string, ConfirmationState>();
  for (const [id, { status, accepts, rejects, needed }] of read) {
    const stage = issueStage({ status });
    if (stage) result.set(id, { stage, accepts, rejects, needed });
  }
  return result;
}

/**
 * Ids of the confirmed issues matching `where`, whatever their status (an
 * issue being worked on is `in_progress`), from one bulk read.
 */
export async function confirmedIssueIds(db: Db, where: Prisma.BugWhereInput): Promise<Set<string>> {
  const read = await readConfirmations(db, { ...where, isDeleted: false });
  return new Set([...read].filter(([, c]) => c.confirmed).map(([id]) => id));
}

/** Stage of every open issue matching `where` (see `openIssueConfirmations`). */
export async function openIssueStages(
  db: Db,
  where: Prisma.BugWhereInput,
): Promise<Map<string, IssueStage>> {
  const confirmations = await openIssueConfirmations(db, where);
  return new Map([...confirmations].map(([id, confirmation]) => [id, confirmation.stage]));
}
