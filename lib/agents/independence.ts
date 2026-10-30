/**
 * Reviewer independence (#442).
 *
 * Two agents owned by the same person must not confirm each other's tickets
 * or mark a fix good to merge. The check is on the owner, not
 * only on the agent id, so a person can't review their own work through a
 * second agent. #433 (validation) and #434 (test verdict) call
 * `assertIndependentReviewer`; they must not reimplement it.
 */

/** The agent doing the review. */
export type ReviewingAgent = { id: string; ownerUserId: string };

type AgentOwner = { ownerUserId: string } | null | undefined;

/** The ticket being reviewed, with the relations the rule needs loaded. */
export type ReviewedBug = {
  /** Who the ticket is for; defaults to the reporter. */
  beneficiaryUserId: string | null;
  /** The person who filed the ticket (web form or agent on their behalf). */
  reporterId?: string | null;
  /** The person assigned to solve the ticket, when there is no active claim. */
  assigneeId?: string | null;
  /** The agent that filed it, if an agent did. */
  createdByAgent?: AgentOwner;
  /** Claims on the ticket; only the active one counts. */
  claims?: ReadonlyArray<{
    status: string;
    releasedAt?: Date | null;
    beneficiaryUserId?: string | null;
    dispatcherUserId?: string | null;
    agent?: AgentOwner;
  }>;
};

export type ReviewerConflict =
  | "created-by-own-agent"
  | "own-ticket"
  | "claimed-by-own-agent"
  | "assigned-solver"
  | "claim-beneficiary"
  | "claim-dispatcher";

const MESSAGES: Record<ReviewerConflict, string> = {
  "created-by-own-agent": "An agent of the same owner filed this ticket, so this agent can't review it.",
  "own-ticket": "This ticket is for the agent's owner, so this agent can't review it.",
  "claimed-by-own-agent": "An agent of the same owner is working on this ticket, so this agent can't review it.",
  "assigned-solver": "The person assigned to solve this ticket can't review it.",
  "claim-beneficiary": "The beneficiary of the active claim can't review this ticket.",
  "claim-dispatcher": "The dispatcher rewarded for the active claim can't review this ticket.",
};

export class ReviewerNotIndependentError extends Error {
  readonly conflict: ReviewerConflict;

  constructor(conflict: ReviewerConflict) {
    super(MESSAGES[conflict]);
    this.name = "ReviewerNotIndependentError";
    this.conflict = conflict;
  }
}

function activeClaimOwner(bug: ReviewedBug): string | null {
  const claim = bug.claims?.find((c) => c.status === "active" && !c.releasedAt);
  return claim?.agent?.ownerUserId ?? null;
}

function activeClaim(bug: ReviewedBug) {
  return bug.claims?.find((c) => c.status === "active" && !c.releasedAt);
}

/**
 * Why `actor` may not review `bug`, or null when it may. Rejects when the
 * actor's owner owns the agent that created the ticket, is the ticket's
 * beneficiary, or owns the agent holding the active claim.
 */
export function reviewerConflict(actor: ReviewingAgent, bug: ReviewedBug): ReviewerConflict | null {
  const owner = actor.ownerUserId;
  if (bug.createdByAgent?.ownerUserId === owner) return "created-by-own-agent";
  // The beneficiary earns the points; the reporter filed the ticket. A human
  // reporter's own agent reviewing that report is the same conflict even
  // though a web-filed bug has no beneficiary set (#620).
  if (bug.beneficiaryUserId === owner || bug.reporterId === owner) return "own-ticket";
  if (activeClaimOwner(bug) === owner) return "claimed-by-own-agent";
  if (bug.assigneeId === owner) return "assigned-solver";
  if (activeClaim(bug)?.beneficiaryUserId === owner) return "claim-beneficiary";
  if (activeClaim(bug)?.dispatcherUserId === owner) return "claim-dispatcher";
  return null;
}

/** Independence checks for the person credited on a review, in addition to the reviewing agent's owner. */
export function reviewerCreditConflict(userId: string, bug: ReviewedBug): ReviewerConflict | null {
  return reviewerConflict({ id: "credited-user", ownerUserId: userId }, bug);
}

/** Throws `ReviewerNotIndependentError` unless `actor` is independent of `bug`. */
export function assertIndependentReviewer(actor: ReviewingAgent, bug: ReviewedBug): void {
  const conflict = reviewerConflict(actor, bug);
  if (conflict) throw new ReviewerNotIndependentError(conflict);
}
