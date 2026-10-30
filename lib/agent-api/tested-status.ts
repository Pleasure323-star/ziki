import type { Prisma, PrismaClient } from "@prisma/client";
import type { ReviewedBug } from "@/lib/agents/independence";
import { countedMergeVerdicts, deliveredClaim } from "@/lib/agent-api/merge-verdicts";
import { workflowFor } from "@/lib/workflow";

/**
 * Done (Ziki #713) is the status of a tested fix: a pull request is linked and
 * the project's required reviewers, each with a different owner and none on the
 * fixer's side, said it is good to merge on that pull request. It sits between
 * In progress and Ready to merge, and moves on its own. Linking a new pull
 * request starts again at In progress.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const bugSelect = {
  id: true,
  projectId: true,
  pullRequestUrl: true,
  assigneeId: true,
  beneficiaryUserId: true,
  reporterId: true,
  createdByAgentId: true,
  createdByAgent: { select: { ownerUserId: true } },
  claims: {
    select: {
      status: true,
      claimedAt: true,
      releasedAt: true,
      agentId: true,
      beneficiaryUserId: true,
      dispatcherUserId: true,
      agent: { select: { ownerUserId: true } },
    },
  },
} satisfies Prisma.BugSelect;

/**
 * The good-to-merge verdicts that count, by the same rule the manager's accept
 * and the merge queue use (`countedMergeVerdicts`), so Done and the merge gate
 * always agree.
 */
export async function countedGoodVerdicts(db: Db, bugId: string): Promise<{ counted: number; needed: number } | null> {
  const bug = await db.bug.findUnique({ where: { id: bugId }, select: bugSelect });
  if (!bug?.pullRequestUrl) return null;
  const verdicts = await db.testVerdict.findMany({
    where: { bugId, goodToMerge: true, pullRequestUrl: bug.pullRequestUrl },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { headSha: true, onBehalfOfUserId: true, agent: { select: { id: true, ownerUserId: true } } },
  });
  const claim = deliveredClaim(bug);
  const { reviewers } = countedMergeVerdicts(verdicts, claim, bug as unknown as ReviewedBug);
  const { verdictsNeeded } = await workflowFor(bug.projectId, db);
  return { counted: reviewers.length, needed: verdictsNeeded };
}

/**
 * Move a fix between In progress and Done after a verdict: enough counted
 * good-to-merge verdicts make it Done, and a verdict that takes the count back
 * (a reviewer changed their mind) returns it to In progress. Later statuses
 * (ready to merge, live, closed) are left alone. Returns the new status when
 * it changed, else null.
 */
export async function refreshTestedStatus(db: Db, bugId: string, actorUserId: string): Promise<"in_progress" | "done" | null> {
  const bug = await db.bug.findUnique({ where: { id: bugId }, select: { status: true, pullRequestUrl: true } });
  if (!bug?.pullRequestUrl) return null;
  if (bug.status !== "in_progress" && bug.status !== "done") return null;

  const count = await countedGoodVerdicts(db, bugId);
  if (!count) return null;
  const next = count.counted >= count.needed ? "done" : "in_progress";
  if (next === bug.status) return null;

  await db.bug.update({ where: { id: bugId }, data: { status: next } });
  await db.bugActivity.create({
    data: {
      bugId,
      actorId: actorUserId,
      type: "status_changed",
      summary:
        next === "done"
          ? ` independent reviewers said good to merge: moved to Done`
          : `Fewer than ${count.needed} independent reviewers say good to merge: back to In progress`,
      metadata: { field: "status", from: bug.status, to: next, counted: count.counted, needed: count.needed },
    },
  });
  return next;
}