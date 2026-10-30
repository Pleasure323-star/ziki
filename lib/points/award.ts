import type { Prisma, PrismaClient } from "@prisma/client";
import { pointSourceKey, roundPoints, type PointRole } from "./rules";
import { calculateSolverPoints, type ProjectRewardConfig } from "./project-rewards";
import { getPlatformRewardConfig, getProjectRewardConfig } from "./platform-rewards";
import { isPullRequestClosedUnmerged } from "@/lib/github/merge-pr";

/**
 * Writes points to the ledger (#428). The backfill (#435), the merge gate
 * (#434) and validations (#433) call `award()`; they must not edit this file.
 *
 * Every award has a `sourceKey`, and `PointEntry.sourceKey` is unique, so the
 * same award written twice adds one row. A correction is a new row with
 * negative points (#436, #450); rows are never deleted.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type PointAward = {
  tenantId: string;
  userId: string;
  bugId: string | null;
  /** Set for an `idea` entry (#idea-table). */
  ideaId?: string | null;
  role: PointRole;
  points: number;
  sourceKey: string;
};

/** Writes `entry` unless an entry with its `sourceKey` exists. True if it was written. */
export async function award(db: Db, entry: PointAward): Promise<boolean> {
  const { count } = await db.pointEntry.createMany({
    data: [{ ...entry, points: roundPoints(entry.points) }],
    skipDuplicates: true,
  });
  return count > 0;
}

export async function awardDispatcher(
  db: Db,
  issue: { id: string; tenantId: string },
  dispatcherUserId: string | null | undefined,
): Promise<boolean> {
  if (!dispatcherUserId) return false;
  const platform = await getPlatformRewardConfig(db);
  return award(db, {
    tenantId: issue.tenantId,
    bugId: issue.id,
    userId: dispatcherUserId,
    role: "dispatcher",
    points: platform.dispatcher,
    sourceKey: `dispatcher:${issue.id}`,
  });
}

export type ResolvedIssue = {
  id: string;
  tenantId: string;
  projectId?: string | null;
  /** Who it was assigned to at resolution time; nobody earns points without one. */
  assigneeId: string | null;
  rewardConfig?: ProjectRewardConfig | null;
  pullRequestUrl?: string | null;
};

/** The solver award for resolving `issue`, or null when nobody is assigned. */
export function solverAward(issue: ResolvedIssue): PointAward | null {
  if (!issue.assigneeId) return null;
  const points = calculateSolverPoints(issue.rewardConfig);

  return {
    tenantId: issue.tenantId,
    userId: issue.assigneeId,
    bugId: issue.id,
    role: "solver",
    points,
    sourceKey: pointSourceKey("solver", issue.id, issue.assigneeId),
  };
}

/** Awards solver points for a resolved issue, once per issue and person. */
export async function awardSolver(db: Db, issue: ResolvedIssue): Promise<boolean> {
  if (!issue.assigneeId) return false;

  // #642: a closed, unmerged pull request earns no solver points.
  if (issue.pullRequestUrl) {
    const isClosed = await isPullRequestClosedUnmerged(issue.pullRequestUrl);
    if (isClosed) return false;
  }

  let rewardConfig = issue.rewardConfig;
  if (rewardConfig === undefined) {
    let projectId = issue.projectId;
    if ("bug" in db) {
      // Look up projectId and pullRequestUrl from the issue row if not supplied
      const bug = await (db as PrismaClient).bug.findUnique({
        where: { id: issue.id },
        select: {
          projectId: true,
          pullRequestUrl: true,
          project: { select: { githubInstallationId: true } },
        },
      });
      if (!projectId) projectId = bug?.projectId;
      if (!issue.pullRequestUrl && bug?.pullRequestUrl) {
        const isClosed = await isPullRequestClosedUnmerged(
          bug.pullRequestUrl,
          bug.project?.githubInstallationId,
        );
        if (isClosed) return false;
      }
    }
    // Always resolve through platform → hard-coded when projectId is missing.
    rewardConfig = await getProjectRewardConfig(db, projectId);
  }

  const entry = solverAward({ ...issue, rewardConfig });
  return entry ? award(db, entry) : false;
}
