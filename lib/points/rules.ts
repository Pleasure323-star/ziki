/**
 * Point rules for the contributor ledger (#428). Amounts are the original
 * epic (#422) figures multiplied by 30. The points goal stays at 500.
 * Super admins can override them.
 */

/** Solver points for a resolved issue: one amount for every issue. */
export const SOLVER_POINTS = 750;

/** Reporter points, once the bug is accepted as real and not a duplicate. */
export const REPORTER_POINTS = 150;

/** Reviewer points, when a "good to merge" verdict is accepted. */
export const REVIEWER_POINTS = 300;

/**
 * Reviewer points for an independent "real" accept that confirms the issue.
 * Separate from the merge verdict so the same person can earn both.
 */
export const CONFIRMATION_REVIEWER_POINTS = 90;

/** Triager points for clearing a report as not a duplicate. */
export const TRIAGER_CLEAR_POINTS = 30;

/** Triager points for marking a report as a duplicate of another issue. */
export const DUPLICATE_MARKER_POINTS = 150;

/** Ledger awards keep this many decimal places. */
export const POINT_DECIMALS = 2;

/**
 * Each later reviewer receives this share of the previous award.
 * A small step keeps the amounts close instead of falling off a cliff.
 */
export const REVIEWER_POINT_RATIO = 0.9;

/**
 * Smallest positive award. Backoff stops shrinking here so a later action
 * still earns something instead of rounding down to zero.
 */
export const MIN_POINT_AWARD = 10 ** -POINT_DECIMALS;

/** A point amount from the ledger: a number, or Prisma's Decimal. */
export type PointAmount = number | { toNumber(): number };

/** Round to the ledger's decimal places. Non-finite values become 0. */
export function roundPoints(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** POINT_DECIMALS;
  return Math.round(value * factor) / factor;
}

/** Read a ledger amount as a number, including sums that come back as Decimal. */
export function pointsNumber(value: PointAmount | string | bigint | null | undefined): number {
  if (value == null) return 0;
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "bigint"
        ? Number(value)
        : typeof value === "string"
          ? Number(value)
          : value.toNumber();
  return roundPoints(raw);
}

/** Display form: 10 stays "10", 0.5 stays "0.5", and float noise is trimmed. */
export function formatPoints(value: number): string {
  const rounded = roundPoints(value);
  if (rounded === 0) return "0";
  return rounded
    .toFixed(POINT_DECIMALS)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

/**
 * The next reviewer's award, given the previous reviewer's award.
 * Take 90% of the previous award, rounded to 2 decimal places.
 * When rounding would leave the amount unchanged, step down by 0.01.
 * The result never falls below 0.01, so every later action still earns points.
 * The first reviewer still receives the full base amount.
 */
export function diminishedReviewerPoints(previous: number): number {
  if (!(previous > 0)) return 0;
  const scaled = roundPoints(previous * REVIEWER_POINT_RATIO);
  if (scaled > 0 && scaled < previous) return scaled;
  const stepped = roundPoints(previous - MIN_POINT_AWARD);
  if (stepped > 0 && stepped < previous) return stepped;
  return MIN_POINT_AWARD;
}

/** Points for the reviewer at `index` (0 is the first), starting from `firstAward`. */
export function reviewerPointsAt(index: number, firstAward: number): number {
  if (index < 0 || !(firstAward > 0)) return 0;
  let points = roundPoints(firstAward);
  if (!(points > 0)) return 0;
  for (let step = 0; step < index; step += 1) {
    points = diminishedReviewerPoints(points);
  }
  return points;
}

/** The goal is this many points. Solved tasks are counted, not required. */
export const TARGET_POINTS = 500;

export const DISPATCHER_POINTS = 60;

/** Largest award a super admin can store for one action. */
export const POINT_AWARD_MAX = 1_000_000;

/** Largest points goal a super admin can store. */
export const POINT_TARGET_MAX = 100_000_000;

export type PointRole = "solver" | "reporter" | "reviewer" | "triager" | "submission" | "dispatcher" | "idea";

/** Paid once per person per idea for their first opinion on it: a validation or a comment (#work-feed). */
export const IDEA_CONTRIBUTION_POINTS = 1;

/** Idempotency key for an idea contribution, so each person earns once per idea. */
export function ideaContributionSourceKey(ideaId: string, userId: string): string {
  return `idea:${ideaId}:${userId}`;
}

/** Idempotency key for paying the triager who cleared an issue as not a duplicate. */
export function triagerClearSourceKey(bugId: string, userId: string): string {
  return `triager-clear:${bugId}:${userId}`;
}

/** Idempotency key for paying the agent that marked an issue as a duplicate. */
export function duplicateMarkerSourceKey(bugId: string, userId: string): string {
  return `duplicate-marker:${bugId}:${userId}`;
}

/** The idempotency key for a job-submission award (#617). */
export function jobSubmissionSourceKey(jobId: string, submissionId: string): string {
  return `job:${jobId}:submission:${submissionId}`;
}

/**
 * The idempotency key for an award. `PointEntry.sourceKey` is unique, so a
 * second award with the same key adds nothing.
 */
export function pointSourceKey(role: PointRole, bugId: string, userId: string): string {
  return `${role}:${bugId}:${userId}`;
}

/** Idempotency key for paying a reviewer who confirmed the issue as real. */
export function confirmationReviewerSourceKey(bugId: string, userId: string): string {
  return `reviewer-confirm:${bugId}:${userId}`;
}

export type PointsProgress = {
  points: number;
  solvedTasks: number;
  /** 0–100, capped. */
  pointsPercent: number;
  /** True once the points goal is met. */
  targetMet: boolean;
};

function percent(value: number, target: number): number {
  return Math.min(100, Math.max(0, Math.floor((value / target) * 100)));
}

/** Progress toward the points goal (hard-coded TARGET_POINTS unless overridden). */
export function pointsProgress(
  points: number,
  solvedTasks: number,
  target: number = TARGET_POINTS,
): PointsProgress {
  const goal = target > 0 ? target : TARGET_POINTS;
  return {
    points,
    solvedTasks,
    pointsPercent: percent(points, goal),
    targetMet: points >= goal,
  };
}
