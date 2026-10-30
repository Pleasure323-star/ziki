/**
 * What anyone decides about an issue is an entry of its current stage (a
 * confirmation, a bid, a test verdict or a merge review). This names the entry
 * route for the stage an issue is in, for the errors that turn a comment away
 * (lib/comment-placement.ts).
 */

import { currentDecisionStage } from "@/lib/decision-stages";

/** The fields of a comment that name the entry it replies to. */
export const ENTRY_REPLY_FIELDS = ["confirmationId", "bidId", "testVerdictId", "mergeReviewId"] as const;

/** Every route that gives a stage entry, for the error that refuses a typed comment. */
export const STAGE_ENTRY_ROUTES = [
  "POST /api/v1/issues/{id}/confirmations (Requires confirmation: confirm, reject or neutral)",
  "POST /api/v1/issues/{id}/bid (Open: a bid)",
  "POST /api/v1/issues/{id}/test-results (Done: good or not good to merge)",
  "POST /api/v1/issues/{id}/merge (Ready to merge: accept or reject)",
] as const;

export type StageEntryKind = "confirmation" | "bid" | "test_verdict" | "merge_review";

export type StageEntryRoute = {
  kind: StageEntryKind;
  /** e.g. `POST /api/v1/issues/{id}/bid`, with the issue's id filled in. */
  route: string;
  /** What the entry is, for people: "a bid". */
  label: string;
};

type IssueStageFields = {
  id: string;
  status: string;
  pullRequestUrl?: string | null;
};

/**
 * The entry the issue's current stage takes, or null when the stage takes
 * none (in progress without a pull request, resolved, closed). The stage is
 * the one rule, `currentDecisionStage`.
 */
export function stageEntryRoute(issue: IssueStageFields): StageEntryRoute | null {
  const path = `/api/v1/issues/${issue.id}`;
  switch (currentDecisionStage({ status: issue.status })) {
    case "confirm":
      return { kind: "confirmation", route: `POST ${path}/confirmations`, label: "a confirmation" };
    case "open":
      return { kind: "bid", route: `POST ${path}/bid`, label: "a bid" };
    case "progress":
      // Testers test a delivered fix; before one is linked the stage takes no entries.
      return issue.pullRequestUrl ? { kind: "test_verdict", route: `POST ${path}/test-results`, label: "a test verdict" } : null;
    case "done":
    case "ready":
      return { kind: "merge_review", route: `POST ${path}/merge`, label: "a merge review" };
    default:
      return null;
  }
}

/** The 400 message for a comment sent with `type` or `metadata`. */
export const TYPED_COMMENT_MESSAGE =
  "Comments have no type or metadata. Stage decisions are entries, each with a summary and a description: " +
  `${STAGE_ENTRY_ROUTES.join("; ")}. A comment replies to one entry (send one of ${ENTRY_REPLY_FIELDS.join(", ")}), ` +
  "or, while the issue is Open, goes on the issue itself or replies to a comment there (parentId).";
