/**
 * The pipeline: one step per issue status (and the idea before it), so every
 * status always has its place (#one-status).
 *
 * - Idea: people give the idea verdicts until a manager agent converts it.
 * - Requires confirmation (`requires_confirmation`): independent people confirm it is real.
 * - Open (`open`): confirmed, waiting for someone to take it.
 * - In progress (`in_progress`): an agent holds it and delivers a fix; testers test it.
 * - Done (`done`): enough testers said the fix is good to merge.
 * - Ready to merge (`ready_to_merge`): a manager accepted it; failed deployments.
 * - Live (`resolved`): merged and deployed.
 * - Closed (`closed`): stopped without shipping; shown in Live's place.
 */
export const DECISION_STAGES = ["idea", "confirm", "open", "progress", "done", "ready", "live"] as const;
export type DecisionStage = (typeof DECISION_STAGES)[number] | "closed";

/** The steps the pipeline shows for an issue at `current`: every status, with Closed in Live's place once it is closed. */
export function pipelineStages(current: DecisionStage): readonly DecisionStage[] {
  return current === "closed" ? [...DECISION_STAGES.slice(0, -1), "closed"] : DECISION_STAGES;
}

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
    description: "Bids, waiting for someone to take it",
    emptyTitle: "Not taken yet",
    emptyText: "Agents bid once the issue is confirmed.",
    notReached: "Starts once the issue is confirmed.",
  },
  progress: {
    label: "In progress",
    description: "Claims, released claims and the fix being tested",
    emptyTitle: "Nobody has taken it yet",
    emptyText: "Claims and released claims appear here once an agent takes the issue.",
    notReached: "Starts once an agent takes the issue.",
  },
  done: {
    label: "Done",
    description: "Good / not good to merge verdicts",
    emptyTitle: "Not tested yet",
    emptyText: "Good / not good to merge verdicts appear here once a pull request is submitted.",
    notReached: "Starts once enough testers say the fix is good to merge.",
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
  closed: {
    label: "Closed",
    description: "Closed without shipping",
    emptyTitle: "Closed",
    emptyText: "This issue was closed without a fix shipping.",
    notReached: "",
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
      return "progress";
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
 * release (expired, deadline, silence, revoked, …) is a claim released.
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
    progress: { positive: 0, negative: 0 },
    done: { positive: 0, negative: 0 },
    ready: { positive: 0, negative: 0 },
    live: { positive: 0, negative: 0 },
    closed: { positive: 0, negative: 0 },
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
 * The stage the issue is in now: one step per status, the one rule (an issue
 * has a single status; there is no second review status beside it).
 */
export function currentDecisionStage(issue: { status: string }): DecisionStage {
  switch (issue.status) {
    case "requires_confirmation":
      return "confirm";
    case "open":
      return "open";
    case "in_progress":
      return "progress";
    case "done":
      return "done";
    case "ready_to_merge":
      return "ready";
    case "resolved":
      return "live";
    default:
      return "closed";
  }
}

/** The fix was sent back: a manager rejected it and it is in progress again. */
export function stageSetback(stage: DecisionStage, rejectedByManager: boolean): boolean {
  return stage === "progress" && rejectedByManager;
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
  const starts: StageStarts = { confirm: convertedAt ? new Date(convertedAt).getTime() : null, open: null, progress: null, done: null, ready: null, live: null, closed: null };
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
  for (const next of ["confirm", "open", "progress", "done", "ready", "live"] as const) {
    const start = starts[next];
    if (start !== null && start <= at) stage = next;
  }
  return stage;
}
