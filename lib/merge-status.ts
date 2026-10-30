import type { PrismaClient } from "@prisma/client";
import type { AgentContext } from "@/lib/agents/require-agent";
import { publish } from "@/lib/agent-api/events";

/**
 * What happened when the admin merge of a fix that is ready to merge did not
 * merge. The issue stays Ready to merge (one status); the outcome is recorded
 * in the activity log and the event, from what GitHub answered:
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

/** The activity line for a merge status: what happened and what didn't. */
export function mergeOutcomeSummary(status: MergeOutcomeStatus, reason: string): string {
  const lead = status === MERGE_BLOCKED ? "Merge blocked" : "Merge failed";
  return `${lead}: ${reason} Nothing was merged on GitHub.`;
}

/**
 * Log a merge that didn't happen in the activity and publish it, in one
 * transaction (#review-entries: no comment). The issue keeps its status. The
 * reason and what the fix's author has to do ride on the activity metadata and
 * the event payload.
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
    await tx.bugActivity.create({
      data: {
        bugId: bug.id,
        actorId: agent.ownerId,
        type: "status_changed",
        summary: mergeOutcomeSummary(status, reason),
        // `note` shows under the line in the activity timeline.
        metadata: { field: "merge", outcome: status, reason, ...(todo ? { todo, note: `What to do: ${todo}` } : {}) },
      },
    });
    await publish(tx, {
      tenantId: bug.tenantId,
      type: "issue.updated",
      payload: { issueId: bug.id, mergeOutcome: status, reason, ...(todo ? { todo } : {}), pullRequestUrl: bug.pullRequestUrl },
      actorAgentId: agent.agentId,
      bugId: bug.id,
    });
  });
}
