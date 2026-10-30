import { DEPLOY_STAGES, type DeployStage } from "@/lib/deploy-stage";
import { parsePullRequestUrl } from "@/lib/github/merge-pr";

/**
 * Merge history: where each completed issue's fix has got to on the
 * dev → staging → main path, shown as three chips per issue.
 *
 * Chip states, matching the merge history design:
 * - merged:     a PR carrying the fix merged into that branch (✓)
 * - open:       a PR into that branch is open (pulsing purple)
 * - not_linked: the fix should have moved on here but no PR is linked (⚠)
 * - pending:    not reached yet (dashed)
 */
export type StepState = "merged" | "open" | "not_linked" | "pending";

/** The stage tabs: All, Only in dev, In staging, In production, Not linked. */
export const MERGE_BUCKETS = ["all", "dev", "staging", "production", "not_linked"] as const;
export type MergeBucket = (typeof MERGE_BUCKETS)[number];

export function parseMergeBucket(value: string | undefined): MergeBucket {
  return (MERGE_BUCKETS as readonly string[]).includes(value ?? "") ? (value as MergeBucket) : "all";
}

/** One PR moving the fix into a branch. */
export type MergeMovement = {
  stage: DeployStage;
  kind: "merged" | "opened";
  prNumber: number;
  prUrl: string | null;
  repo: string | null;
  at: Date | null;
};

export type MergePath = {
  steps: Record<DeployStage, StepState>;
  /** Oldest first. */
  movements: MergeMovement[];
  /** Which stage tab the issue counts under; null while its PR is still open into dev. */
  bucket: Exclude<MergeBucket, "all"> | null;
};

export type MergeHistoryIssue = {
  pullRequestUrl: string | null;
  status: string;
  updatedAt: Date;
};

/**
 * The path for one completed issue.
 *
 * TODO(merger fields): today the issue only records its own PR and whether it
 * merged (into dev). Once the merger agent records the staging sync and release
 * PRs, pass them as `later` and staging / main light up from them.
 */
export function mergePathOf(issue: MergeHistoryIssue, later: MergeMovement[] = []): MergePath {
  const steps: Record<DeployStage, StepState> = { dev: "pending", staging: "pending", main: "pending" };
  const pr = parsePullRequestUrl(issue.pullRequestUrl);

  if (!pr) {
    steps.dev = "not_linked";
    return { steps, movements: [], bucket: "not_linked" };
  }

  // A fix that went live merged into dev at least.
  const merged = issue.status === "resolved";
  const movements: MergeMovement[] = [
    { stage: "dev", kind: merged ? "merged" : "opened", prNumber: pr.number, prUrl: issue.pullRequestUrl, repo: `${pr.owner}/${pr.repo}`, at: issue.updatedAt },
    ...later.filter((m) => m.stage !== "dev"),
  ];
  for (const m of movements) {
    if (steps[m.stage] !== "merged") steps[m.stage] = m.kind === "merged" ? "merged" : "open";
  }

  if (!merged) return { steps, movements, bucket: null };
  const bucket = steps.main === "merged" ? "production" : steps.staging === "merged" ? "staging" : "dev";
  return { steps, movements, bucket };
}

/** The furthest stage the fix has merged into, for screen readers ("Reached staging"). */
export function describePath(path: MergePath): string {
  const reached = [...DEPLOY_STAGES].reverse().find((s) => path.steps[s] === "merged");
  if (path.bucket === "not_linked") return "No pull request linked";
  if (!reached) return "Pull request open into dev";
  const open = DEPLOY_STAGES.find((s) => path.steps[s] === "open");
  return open ? `Reached ${reached}, pull request open into ${open}` : `Reached ${reached}`;
}

/** "PR #2047 opened into main", for the Latest movement column and the expanded list. */
export function movementLabel(m: MergeMovement): string {
  return `PR #${m.prNumber} ${m.kind === "merged" ? "merged" : "opened"} into ${m.stage}`;
}

export function latestMovement(path: MergePath): MergeMovement | null {
  return path.movements.at(-1) ?? null;
}

/** The release PR view: issues grouped under the PR that carried them, newest first. */
export function groupByPullRequest<T extends { path: MergePath }>(rows: T[]): { movement: MergeMovement; rows: T[] }[] {
  const groups = new Map<string, { movement: MergeMovement; rows: T[] }>();
  for (const row of rows) {
    for (const m of row.path.movements) {
      const key = `${m.repo ?? ""}#${m.prNumber}`;
      const group = groups.get(key);
      if (group) group.rows.push(row);
      else groups.set(key, { movement: m, rows: [row] });
    }
  }
  return [...groups.values()].sort((a, b) => (b.movement.at?.getTime() ?? 0) - (a.movement.at?.getTime() ?? 0));
}
