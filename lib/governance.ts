import type { AgentLevel } from "@prisma/client";
import { hasLevel } from "@/lib/agents/levels";
import type { ProjectWorkflowValues } from "@/lib/workflow-config";

/**
 * Vote governance (#vote-governance). A project decides its voted steps one of
 * two ways (`ProjectWorkflow.governance`):
 *
 * - `manager` (the default): when a step's votes reach its threshold, a
 *   manager agent acts (converts the idea, rejects it, closes the issue,
 *   awards a bid, accepts the fix).
 * - `threshold`: no manager action is needed. The vote that crosses the
 *   threshold does the step, in the same transaction, attributed to that vote.
 *
 * Either way a vote is weighted the same: a manager or merger agent's counts
 * the project's `managerVoteWeight`, a person's own vote or a working agent's
 * counts 1, and each person (owner) counts once, at their highest weight.
 */

export type Governance = Pick<ProjectWorkflowValues, "governance" | "managerVoteWeight">;

/** True when crossing a step's threshold does the step itself. */
export function isThresholdOnly(workflow: Pick<ProjectWorkflowValues, "governance">): boolean {
  return workflow.governance === "threshold";
}

/** What one vote counts: `managerVoteWeight` for a manager or merger agent, else 1 (a person, or a working agent). */
export function voteWeight(level: AgentLevel | null | undefined, managerVoteWeight: number): number {
  return level && hasLevel(level, "manager") ? managerVoteWeight : 1;
}

/** One vote in a tally: the person it counts for, and the class of the agent that cast it (none for a person's own vote). */
export type CastVote = { ownerId: string; level: AgentLevel | null | undefined };

/** The weighted tally: one vote per person, at the highest weight any of their agents cast. */
export function weightedTally(votes: Iterable<CastVote>, managerVoteWeight: number): number {
  const byOwner = new Map<string, number>();
  for (const vote of votes) {
    const weight = voteWeight(vote.level, managerVoteWeight);
    byOwner.set(vote.ownerId, Math.max(byOwner.get(vote.ownerId) ?? 0, weight));
  }
  let total = 0;
  for (const weight of byOwner.values()) total += weight;
  return total;
}

/** "managers' votes count 3", for feed and page text. */
export function managerWeightNote(managerVoteWeight: number): string {
  return `managers' votes count ${managerVoteWeight}`;
}

/** "6 of 10; managers' votes count 3". */
export function tallyLine(votes: number, threshold: number, managerVoteWeight: number): string {
  return `${votes} of ${threshold}; ${managerWeightNote(managerVoteWeight)}`;
}

/** Recorded on what a threshold vote did: in the activity metadata, the event and the audit row. */
export type ThresholdDecision = {
  via: "threshold";
  /** The person whose vote crossed the threshold. */
  decidedByUserId: string;
  /** Their agent, when an agent cast it. */
  decidedByAgentId: string | null;
  votes: number;
  threshold: number;
};

export function thresholdDecision(
  voter: { userId: string; agentId?: string | null },
  votes: number,
  threshold: number,
): ThresholdDecision {
  return { via: "threshold", decidedByUserId: voter.userId, decidedByAgentId: voter.agentId ?? null, votes, threshold };
}
