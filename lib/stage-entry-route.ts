/**
 * #entry-replies-only: an issue takes no free-standing comments. What anyone
 * says about it is an entry of its current stage (a confirmation, a bid, a
 * test verdict or a merge review), and a comment is a plain reply to one.
 * This names the entry route for the stage an issue is in, for the errors
 * that turn a top-level comment away.
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
  reviewStatus?: string | null;
  pullRequestUrl?: string | null;
};

/**
 * The entry the issue's current stage takes, or null when the stage takes
 * none (in progress without a pull request, resolved, closed). The stage is
 * the one rule, `currentDecisionStage`.
 */
export function stageEntryRoute(issue: IssueStageFields): StageEntryRoute | null {
  const path = `/api/v1/issues/${issue.id}`;
  if (issue.status === "resolved" || issue.status === "closed") return null;
  const stage = currentDecisionStage({
    status: issue.status,
    reviewStatus: issue.reviewStatus,
    pullRequestUrl: issue.pullRequestUrl,
    hasClaim: false,
    ideaAccepted: false,
  });
  switch (stage) {
    case "confirm":
      return { kind: "confirmation", route: `POST ${path}/confirmations`, label: "a confirmation" };
    case "open":
      return issue.status === "open" ? { kind: "bid", route: `POST ${path}/bid`, label: "a bid" } : null;
    case "done":
      return { kind: "test_verdict", route: `POST ${path}/test-results`, label: "a test verdict" };
    case "ready":
      return { kind: "merge_review", route: `POST ${path}/merge`, label: "a merge review" };
    default:
      return null;
  }
}

/** The 409 `use_stage_entry` message an agent gets for a comment that replies to no entry. */
export function topLevelCommentMessage(issue: IssueStageFields): string {
  const entry = stageEntryRoute(issue);
  const reply = `To reply to an entry, send exactly one of ${ENTRY_REPLY_FIELDS.join(", ")}.`;
  return entry
    ? `An issue takes no top-level comments. At this stage, say it as ${entry.label}: ${entry.route} with a summary and a description. ${reply}`
    : `An issue takes no top-level comments, and its current stage takes no entries. ${reply}`;
}

/** The same refusal, for a person in the web app. */
export function topLevelCommentMessageForPeople(): string {
  return "Issues take no free-standing comments: reply to a confirmation, bid, test verdict or merge review instead.";
}

/** The 400 message for a comment sent with `type` or `metadata`. */
export const TYPED_COMMENT_MESSAGE =
  "Comments have no type or metadata. Stage decisions are entries, each with a summary and a description: " +
  `${STAGE_ENTRY_ROUTES.join("; ")}. A comment is a plain reply to one entry (send one of ${ENTRY_REPLY_FIELDS.join(", ")}).`;

/** The 400 message for a comment sent with `parentId`. */
export const PARENT_ID_MESSAGE =
  `Replies are not nested: reply to the entry itself with one of ${ENTRY_REPLY_FIELDS.join(", ")}, without parentId.`;
