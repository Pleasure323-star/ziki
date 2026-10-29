/**
 * The six stages an issue's agent decisions and conversation are grouped by
 * on the issue page, and counted by on the issues list card (#1446).
 *
 * - Idea: people give the idea verdicts until a manager agent converts it.
 * - Requires confirmation: the first step of an issue. Reviewers confirm it is
 *   real, or reject it, and an agent checks it is not a duplicate (#714).
 * - Open: an agent claims it, or the claim is released.
 * - Done: testers say the fix is good to merge, or not.
 * - Ready to merge: a merger accepts or rejects the fix; failed deployments.
 * - Live: the admin merger merged and deployed it.
 */
export const DECISION_STAGES = ["idea", "confirm", "open", "done", "ready", "live"] as const;
export type DecisionStage = (typeof DECISION_STAGES)[number];

export const decisionStageInfo: Record<
  DecisionStage,
  { label: string; description: string; emptyTitle: string; emptyText: string; notReached: string }
> = {
  idea: {
    label: "Idea",
    description: "Verdicts on the idea, until a manager agent converts it",
    emptyTitle: "No verdicts yet",
    emptyText: "People give the idea good, bad or neutral verdicts; a manager agent then converts it to an issue.",
    notReached: "Starts once the issue is reported.",
  },
  confirm: {
    label: "Requires confirmation",
    description: "Confirmations, rejections and the duplicate check",
    emptyTitle: "Not confirmed yet",
    emptyText: "Reviewer agents confirm the issue is real, and an agent checks it is not a duplicate.",
    notReached: "Starts once a manager agent converts the idea to an issue.",
  },
  open: {
    label: "Open",
    description: "Claims and rejected claims",
    emptyTitle: "No claims yet",
    emptyText: "Claims and rejected claims appear here once the issue is confirmed.",
    notReached: "Starts once the issue is confirmed.",
  },
  done: {
    label: "Done",
    description: "Testing logs and good / not good to merge verdicts",
    emptyTitle: "Not tested yet",
    emptyText: "Testing logs and good / not good to merge verdicts appear here once a pull request is submitted.",
    notReached: "Starts once a pull request is submitted.",
  },
  ready: {
    label: "Ready to merge",
    description: "Merger agent verdicts and failed deployments",
    emptyTitle: "Not ready to merge yet",
    emptyText:
      "The merger agent posts its verdict once testing marks the fix good to merge. Failed deployments are logged here too.",
    notReached: "Starts once testing marks the fix good to merge.",
  },
  live: {
    label: "Live",
    description: "Successful deployments",
    emptyTitle: "Not live yet",
    emptyText: "Admin-merger deployment logs appear here once the fix is deployed.",
    notReached: "Starts once the fix is merged and deployed.",
  },
};

export type DecisionKind =
  | "confirmed"
  | "rejected"
  | "claimed"
  | "claim_released"
  | "verdict"
  | "accepted"
  | "merge_rejected"
  | "deploy_failed";

/** Just what the stage and tone depend on, so list counts need no full decision. */
export type DecisionLike = { kind: DecisionKind; goodToMerge?: boolean; merged?: boolean };

export type DecisionTone = "positive" | "negative";

export function stageOfDecision(decision: DecisionLike): DecisionStage {
  switch (decision.kind) {
    case "confirmed":
    case "rejected":
      return "confirm";
    case "claimed":
    case "claim_released":
      return "open";
    case "verdict":
      return "done";
    case "accepted":
      // The admin merger's accept carries `merged: true`: the fix shipped.
      return decision.merged ? "live" : "ready";
    case "merge_rejected":
    case "deploy_failed":
      return "ready";
  }
}

export function decisionTone(decision: DecisionLike): DecisionTone {
  switch (decision.kind) {
    case "rejected":
    case "claim_released":
    case "merge_rejected":
    case "deploy_failed":
      return "negative";
    case "verdict":
      return decision.goodToMerge ? "positive" : "negative";
    default:
      return "positive";
  }
}

/**
 * What a claim counts as. Offers never taken up are not claims. A claim
 * released because the issue was resolved or closed did its job; any other
 * release (expired, deadline, silence, revoked, …) is a claim rejected.
 */
export function claimDecisionKind(claim: {
  status: string;
  claimedAt: Date | string | null;
  releaseReason: string | null;
}): "claimed" | "claim_released" | null {
  if (!claim.claimedAt || claim.status === "offered") return null;
  if (claim.status !== "released") return "claimed";
  return claim.releaseReason === "resolved" || claim.releaseReason === "closed" ? "claimed" : "claim_released";
}

/** The admin merger's accept that merged the fix carries `merged: true` in its audit payload. */
export function payloadMerged(payload: unknown): boolean {
  return !!payload && typeof payload === "object" && (payload as { merged?: unknown }).merged === true;
}

export type StageTally = { positive: number; negative: number };
export type StageTallies = Record<DecisionStage, StageTally>;

export function emptyStageTallies(): StageTallies {
  return {
    idea: { positive: 0, negative: 0 },
    confirm: { positive: 0, negative: 0 },
    open: { positive: 0, negative: 0 },
    done: { positive: 0, negative: 0 },
    ready: { positive: 0, negative: 0 },
    live: { positive: 0, negative: 0 },
  };
}

/** Positive and negative counts per stage. `count` lets grouped rows add up at once. */
export function tallyStages(decisions: Iterable<DecisionLike & { count?: number }>): StageTallies {
  const tallies = emptyStageTallies();
  for (const decision of decisions) {
    tallies[stageOfDecision(decision)][decisionTone(decision)] += decision.count ?? 1;
  }
  return tallies;
}

/**
 * The stage the issue is in now, which the issue page opens on. Every issue
 * was converted from an idea (#idea-table), so it starts at Requires
 * confirmation. `ideaAccepted`: the issue is confirmed (stage `ready`).
 */
export function currentDecisionStage(issue: {
  status: string;
  reviewStatus: string | null | undefined;
  pullRequestUrl: string | null | undefined;
  hasClaim: boolean;
  ideaAccepted: boolean;
}): DecisionStage {
  if (issue.reviewStatus === "merged") return "live";
  // A blocked or failed merge is still waiting at Ready to merge.
  if (issue.reviewStatus === "ready_to_merge" || issue.reviewStatus === "merge_blocked" || issue.reviewStatus === "merge_failed") {
    return "ready";
  }
  if (issue.pullRequestUrl || issue.reviewStatus === "submitted" || issue.reviewStatus === "rejected") return "done";
  if (issue.status === "resolved") return "live";
  if (issue.status === "in_progress" || issue.hasClaim || issue.ideaAccepted) return "open";
  return "confirm";
}

/**
 * When each stage after Idea began, from its first decision; null when not
 * reached. Requires confirmation begins when the idea is converted, if known.
 */
export type StageStarts = Record<Exclude<DecisionStage, "idea">, number | null>;

export function stageStarts(
  decisions: Iterable<DecisionLike & { at: Date | string }>,
  convertedAt?: Date | string | null,
): StageStarts {
  const starts: StageStarts = { confirm: convertedAt ? new Date(convertedAt).getTime() : null, open: null, done: null, ready: null, live: null };
  for (const decision of decisions) {
    const stage = stageOfDecision(decision);
    if (stage === "idea") continue;
    const at = new Date(decision.at).getTime();
    if (starts[stage] === null || at < starts[stage]) starts[stage] = at;
  }
  return starts;
}

/** The stage the issue was in at `time`: the latest one that had begun. */
export function stageAt(time: Date | string, starts: StageStarts): DecisionStage {
  const at = new Date(time).getTime();
  let stage: DecisionStage = "idea";
  for (const next of ["confirm", "open", "done", "ready", "live"] as const) {
    const start = starts[next];
    if (start !== null && start <= at) stage = next;
  }
  return stage;
}
