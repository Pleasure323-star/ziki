import type { Prisma, PrismaClient } from "@prisma/client";
import type { ReviewedBug } from "@/lib/agents/independence";
import { countedMergeVerdicts, deliveredClaim } from "@/lib/agent-api/merge-verdicts";
import { publish } from "@/lib/agent-api/events";
import { workflowFor } from "@/lib/workflow";

/**
 * The Delivered step's rule (#delivered-step). Once the agent holding the
 * claim delivers its work, independent agents judge it (test verdicts on the
 * delivered pull request):
 *
 * - When the project's required number of them, each with a different owner
 *   and none on the delivering side, say it is good to merge, it is Done.
 * - Otherwise, when that many say it is not good to merge, it goes back to
 *   Open: the claim is released and the pull request is cleared, so someone
 *   (the same agent or another) can take it again.
 * - Otherwise it stays Delivered.
 *
 * Both counts use the merge gate's rule (`countedMergeVerdicts`), so Done and
 * the manager's accept always agree.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const bugSelect = {
  id: true,
  tenantId: true,
  projectId: true,
  status: true,
  pullRequestUrl: true,
  assigneeId: true,
  beneficiaryUserId: true,
  reporterId: true,
  createdByAgentId: true,
  createdByAgent: { select: { ownerUserId: true } },
  claims: {
    select: {
      id: true,
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

/** The judgements that count on the delivered pull request, good and not good, and how many are needed. */
export async function countedJudgements(
  db: Db,
  bugId: string,
): Promise<{ good: number; notGood: number; needed: number } | null> {
  const bug = await db.bug.findUnique({ where: { id: bugId }, select: bugSelect });
  if (!bug?.pullRequestUrl) return null;
  const verdicts = await db.testVerdict.findMany({
    where: { bugId, pullRequestUrl: bug.pullRequestUrl },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { goodToMerge: true, headSha: true, onBehalfOfUserId: true, agent: { select: { id: true, ownerUserId: true } } },
  });
  const claim = deliveredClaim(bug);
  const reviewed = bug as unknown as ReviewedBug;
  const good = countedMergeVerdicts(verdicts.filter((v) => v.goodToMerge), claim, reviewed).reviewers.length;
  const notGood = countedMergeVerdicts(verdicts.filter((v) => !v.goodToMerge), claim, reviewed).reviewers.length;
  const { verdictsNeeded } = await workflowFor(bug.projectId, db);
  return { good, notGood, needed: verdictsNeeded };
}

/**
 * Apply the rule after a judgement. Acts only on a Delivered or Done issue
 * (a judgement taken back can return Done to Delivered). Returns the new
 * status when it changed, else null.
 */
export async function refreshJudgedStatus(
  db: Db,
  bugId: string,
  actorUserId: string,
): Promise<"delivered" | "done" | "open" | null> {
  const bug = await db.bug.findUnique({ where: { id: bugId }, select: bugSelect });
  if (!bug?.pullRequestUrl) return null;
  if (bug.status !== "delivered" && bug.status !== "done") return null;

  const count = await countedJudgements(db, bugId);
  if (!count) return null;
  const next = count.good >= count.needed ? "done" : count.notGood >= count.needed ? "open" : "delivered";
  if (next === bug.status) return null;

  if (next === "open") {
    // Judged not good to merge: back to Open, for someone to take again.
    const now = new Date();
    const held = bug.claims.filter((claim) => !claim.releasedAt && (claim.status === "active" || claim.status === "offered"));
    for (const claim of held) {
      await db.issueClaim.update({ where: { id: claim.id }, data: { status: "released", releasedAt: now, releaseReason: "judged_not_good" } });
      await publish(db, {
        tenantId: bug.tenantId,
        type: "claim.released",
        actorAgentId: null,
        bugId,
        payload: { claimId: claim.id, issueId: bugId, beneficiaryUserId: claim.beneficiaryUserId, reason: "judged_not_good" },
      });
    }
    await db.bug.update({
      where: { id: bugId },
      data: { status: "open", assigneeId: null, pullRequestUrl: null, pullRequestHeadSha: null },
    });
  } else {
    await db.bug.update({ where: { id: bugId }, data: { status: next } });
  }

  await db.bugActivity.create({
    data: {
      bugId,
      actorId: actorUserId,
      type: "status_changed",
      summary:
        next === "done"
          ? `${count.good} independent agents judged the delivered work good to merge: moved to Done`
          : next === "open"
            ? `${count.notGood} independent agents judged the delivered work not good to merge: back to Open`
            : `Fewer than ${count.needed} independent agents judge it good to merge: back to Delivered`,
      metadata: { field: "status", from: bug.status, to: next, good: count.good, notGood: count.notGood, needed: count.needed },
    },
  });
  return next;
}
