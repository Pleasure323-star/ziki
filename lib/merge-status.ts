import type { PrismaClient } from "@prisma/client";
import type { AgentContext } from "@/lib/agents/require-agent";
import { publish } from "@/lib/agent-api/events";

/**
 * Merge statuses for a fix that is ready to merge but did not merge. They live
 * on `Bug.reviewStatus` next to `submitted`, `ready_to_merge`, `rejected` and
 * `merged`, and only the admin merge sets them, from what GitHub answered:
 *
 * - `merge_blocked`: a check before the merge stopped it (no GitHub App, the
 *   pull request closed or changed, checks not green, CodeRabbit threads open,
 *   or GitHub unreachable). Nothing was sent to GitHub.
 * - `merge_failed`: the merge was sent and GitHub refused it.
 *
 * Neither resolves the issue or pays points. The admin merger can try again
 * once the reason is fixed.
 */
export const MERGE_BLOCKED = "merge_blocked";
export const MERGE_FAILED = "merge_failed";
export type MergeOutcomeStatus = typeof MERGE_BLOCKED | typeof MERGE_FAILED;

/** Every review status an issue can show, in pipeline order. `tested` is the Done step (Ziki #713). */
export const REVIEW_STATUSES = ["submitted", "tested", "ready_to_merge", "rejected", MERGE_BLOCKED, MERGE_FAILED, "merged"] as const;

/** The activity line for a merge status: what happened and what didn't. */
export function mergeOutcomeSummary(status: MergeOutcomeStatus, reason: string): string {
  const lead = status === MERGE_BLOCKED ? "Merge blocked" : "Merge failed";
  return `${lead}: ${reason} Nothing was merged on GitHub.`;
}

/**
 * Set the merge status, log it in the activity and publish it, in one
 * transaction (#review-entries: no comment). The reason and what the fix's
 * author has to do ride on the activity metadata and the event payload.
 */
export async function recordMergeOutcome(
  db: PrismaClient,
  input: {
    agent: AgentContext;
    bug: { id: string; tenantId: string; pullRequestUrl: string | null };
    status: MergeOutcomeStatus;
    reason: string;
    /** What the fix's author has to do next. */
    todo?: string;
  },
): Promise<void> {
  const { agent, bug, status, reason, todo } = input;
  await db.$transaction(async (tx) => {
    await tx.bug.update({ where: { id: bug.id }, data: { reviewStatus: status } });
    await tx.bugActivity.create({
      data: {
        bugId: bug.id,
        actorId: agent.ownerId,
        type: "status_changed",
        summary: mergeOutcomeSummary(status, reason),
        // `note` shows under the line in the activity timeline.
        metadata: { field: "reviewStatus", reviewStatus: status, reason, ...(todo ? { todo, note: `What to do: ${todo}` } : {}) },
      },
    });
    await publish(tx, {
      tenantId: bug.tenantId,
      type: "issue.updated",
      payload: { issueId: bug.id, reviewStatus: status, reason, ...(todo ? { todo } : {}), pullRequestUrl: bug.pullRequestUrl },
      actorAgentId: agent.agentId,
      bugId: bug.id,
    });
  });
}
