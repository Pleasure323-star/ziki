import type { Prisma, PrismaClient, Severity, Status } from "@prisma/client";
import { award, type PointAward } from "./award";
import { pointSourceKey, REPORTER_POINTS, solverPoints } from "./rules";
import {
  calculateReporterPoints,
  calculateSolverPoints,
  getProjectRewardConfig,
  type ProjectRewardConfig,
} from "./project-rewards";
import { isConfirmed } from "@/lib/agent-api/validation";

/**
 * Points for tickets that existed before the ledger (#435), by the same
 * rules as new work (#428). Operator-run through `scripts/backfill-points.ts`.
 *
 * Every entry uses the key `award()` uses, so running this twice, or after a
 * real award for the same ticket, pays once. There were no test verdicts
 * before the platform, so no reviewer points are invented.
 *
 * Amounts honor each issue's project reward configuration (#600) — the same
 * configuration live awards use — with the standard values as the fallback.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Date the agent platform and contributor ledger were introduced. */
export const PLATFORM_CUTOFF_DATE = new Date("2026-10-21T00:00:00.000Z");

export type HistoricalBug = {
  id: string;
  tenantId: string;
  /** Optional; only used to resolve the issue's project reward config (#600). */
  projectId?: string | null;
  status: Status;
  severity: Severity;
  assigneeId: string | null;
  reporterId: string;
  beneficiaryUserId?: string | null;
  duplicateOfId: string | null;
  isDeleted: boolean;
  createdByAgentId?: string | null;
  createdAt?: Date;
  isConfirmed?: boolean;
};

const FINISHED: ReadonlySet<Status> = new Set<Status>(["resolved", "closed"]);

export function isModernBug(bug: HistoricalBug, cutoffDate?: Date): boolean {
  if (bug.createdByAgentId) return true;
  if (cutoffDate && bug.createdAt && bug.createdAt >= cutoffDate) return true;
  return false;
}

/** The awards a ticket earns: solver for its assignee once finished, reporter unless it's a duplicate.
 * For modern/agent-platform issues (#715), reporter points require independent confirmation.
 */
export function backfillEntries(
  bug: HistoricalBug,
  options?: { cutoffDate?: Date; rewardConfig?: ProjectRewardConfig | null },
): PointAward[] {
  // A deleted ticket was taken back; it earns nothing.
  if (bug.isDeleted) return [];
  const rewardConfig = options?.rewardConfig;
  const entries: PointAward[] = [];
  if (FINISHED.has(bug.status) && bug.assigneeId) {
    entries.push({
      tenantId: bug.tenantId,
      userId: bug.assigneeId,
      bugId: bug.id,
      role: "solver",
      points: rewardConfig ? calculateSolverPoints(bug.severity, rewardConfig) : solverPoints(bug.severity),
      sourceKey: pointSourceKey("solver", bug.id, bug.assigneeId),
    });
  }
  if (!bug.duplicateOfId) {
    const modern = isModernBug(bug, options?.cutoffDate);
    // Modern agent-platform issues require confirmation (#715)
    if (!modern || bug.isConfirmed) {
      const recipientId = (modern ? bug.beneficiaryUserId : null) ?? bug.reporterId;
      entries.push({
        tenantId: bug.tenantId,
        userId: recipientId,
        bugId: bug.id,
        role: "reporter",
        points: rewardConfig ? calculateReporterPoints(rewardConfig) : REPORTER_POINTS,
        sourceKey: pointSourceKey("reporter", bug.id, recipientId),
      });
    }
  }
  return entries;
}

export type BackfillLine = PointAward & { alreadyAwarded: boolean };

export type BackfillResult = {
  bugs: number;
  /** Entries the rules give, including ones already in the ledger. */
  planned: number;
  /** Rows actually inserted (always 0 for a dry run). */
  written: number;
  /** Planned entries already in the ledger, skipped. */
  existing: number;
};

export type BackfillOptions = {
  /** Print what would be awarded and write nothing. */
  dryRun?: boolean;
  /** Called once per planned entry, e.g. to print it. */
  onLine?: (line: BackfillLine) => void;
  batchSize?: number;
  /** Issues created at or after this date use modern confirmation rules (#715). */
  cutoffDate?: Date;
};

async function checkConfirmed(db: Db, bug: HistoricalBug): Promise<boolean> {
  if (bug.isConfirmed !== undefined) return bug.isConfirmed;
  const anyDb = db as unknown as { issueValidation?: unknown; bug?: { findUnique?: unknown } };
  if (!anyDb.issueValidation || !anyDb.bug?.findUnique) return false;
  return isConfirmed(bug.id, db);
}

/** Walks every ticket in id order and awards what it earns. */
export async function backfillPoints(db: Db, options: BackfillOptions = {}): Promise<BackfillResult> {
  const { dryRun = false, onLine, batchSize = 500, cutoffDate = PLATFORM_CUTOFF_DATE } = options;
  if (cutoffDate && Number.isNaN(cutoffDate.getTime())) {
    throw new Error("Invalid cutoffDate provided to backfillPoints");
  }
  const result: BackfillResult = { bugs: 0, planned: 0, written: 0, existing: 0 };
  let cursor: string | undefined;
  // One reward config read per project, across batches (the config is per
  // project, not per issue, so walking 5,000 issues reads each project once).
  const rewardConfigs = new Map<string, ProjectRewardConfig>();
  const rewardConfigFor = async (bug: HistoricalBug): Promise<ProjectRewardConfig | null> => {
    if (!bug.projectId) return null;
    if (!rewardConfigs.has(bug.projectId)) {
      rewardConfigs.set(bug.projectId, await getProjectRewardConfig(db, bug.projectId));
    }
    return rewardConfigs.get(bug.projectId) ?? null;
  };

  for (;;) {
    const bugs: HistoricalBug[] = await db.bug.findMany({
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        tenantId: true,
        projectId: true,
        status: true,
        severity: true,
        assigneeId: true,
        reporterId: true,
        beneficiaryUserId: true,
        duplicateOfId: true,
        isDeleted: true,
        createdByAgentId: true,
        createdAt: true,
      },
    });
    if (bugs.length === 0) break;
    result.bugs += bugs.length;
    cursor = bugs[bugs.length - 1].id;

    for (const b of bugs) {
      if (isModernBug(b, cutoffDate) && b.isConfirmed === undefined) {
        b.isConfirmed = await checkConfirmed(db, b);
      }
    }

    const entries: Array<PointAward & { projectId?: string | null }> = [];
    for (const b of bugs) {
      const rewardConfig = await rewardConfigFor(b);
      entries.push(...backfillEntries(b, { cutoffDate, rewardConfig }));
    }
    if (entries.length > 0) {
      const present = await db.pointEntry.findMany({
        where: { sourceKey: { in: entries.map((e) => e.sourceKey) } },
        select: { sourceKey: true },
      });
      const already = new Set(present.map((p) => p.sourceKey));

      for (const entry of entries) {
        result.planned++;
        let alreadyAwarded = already.has(entry.sourceKey);
        // award() skips an existing key, so if a real award wins the race
        // after the lookup above, the entry counts as existing, not lost.
        if (!dryRun && !alreadyAwarded) {
          if (await award(db, entry)) result.written++;
          else alreadyAwarded = true;
        }
        if (alreadyAwarded) result.existing++;
        onLine?.({ ...entry, alreadyAwarded });
      }
    }
    if (bugs.length < batchSize) break;
  }
  return result;
}

export const BACKFILL_USAGE = "Usage: pnpm tsx scripts/backfill-points.ts [--dry-run] [--verbose] [--cutoff=<ISO date>]";

/**
 * The script's flags. Anything else is an error, checked before connecting:
 * a mistyped `--dryrun` must never fall through to a real run that writes.
 */
export function parseBackfillArgs(
  args: ReadonlyArray<string>,
): { ok: true; dryRun: boolean; verbose: boolean; cutoffDate?: Date } | { ok: false; error: string } {
  let cutoffDate: Date | undefined;
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run" || arg === "--verbose") {
      continue;
    }
    if (arg.startsWith("--cutoff=")) {
      const raw = arg.slice("--cutoff=".length);
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        return { ok: false, error: `Invalid date for --cutoff: ${raw}\n${BACKFILL_USAGE}` };
      }
      cutoffDate = parsed;
      continue;
    }
    if (arg === "--cutoff") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        return { ok: false, error: `Missing date argument for --cutoff\n${BACKFILL_USAGE}` };
      }
      const parsed = new Date(next);
      if (Number.isNaN(parsed.getTime())) {
        return { ok: false, error: `Invalid date for --cutoff: ${next}\n${BACKFILL_USAGE}` };
      }
      cutoffDate = parsed;
      i++;
      continue;
    }
    unknown.push(arg);
  }

  if (unknown.length > 0) {
    return { ok: false, error: `Unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(" ")}\n${BACKFILL_USAGE}` };
  }
  const dryRun = args.includes("--dry-run");
  return { ok: true, dryRun, verbose: dryRun || args.includes("--verbose"), cutoffDate };
}
