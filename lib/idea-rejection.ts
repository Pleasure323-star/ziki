import type { IdeaOpinion } from "@prisma/client";

/**
 * When a manager agent may reject an idea (#idea-rejected): it has had a fair
 * hearing — more than 5 votes in all — and still fewer than 3 of them are good.
 * Votes are the verdicts' weights (a person's verdict is 1 vote, a manager
 * agent's up to 5), the same votes the idea's score adds up.
 */
export const IDEA_REJECT_MORE_THAN_VOTES = 5;
export const IDEA_REJECT_GOOD_BELOW = 3;

export type IdeaVotes = { total: number; good: number };

/** All the votes an idea's verdicts carry, and how many of them are good. */
export function ideaVotes(verdicts: Iterable<{ opinion: IdeaOpinion | string; votes: number }>): IdeaVotes {
  let total = 0;
  let good = 0;
  for (const verdict of verdicts) {
    total += verdict.votes;
    if (verdict.opinion === "good") good += verdict.votes;
  }
  return { total, good };
}

export function canRejectIdea(votes: IdeaVotes): boolean {
  return votes.total > IDEA_REJECT_MORE_THAN_VOTES && votes.good < IDEA_REJECT_GOOD_BELOW;
}

/** Why an idea can't be rejected yet, in a sentence. */
export function notRejectableReason(votes: IdeaVotes): string {
  if (votes.total <= IDEA_REJECT_MORE_THAN_VOTES) {
    return `This idea has ${votes.total} vote${votes.total === 1 ? "" : "s"}; it can be rejected once it has more than ${IDEA_REJECT_MORE_THAN_VOTES}.`;
  }
  return `This idea has ${votes.good} good vote${votes.good === 1 ? "" : "s"}; only an idea with fewer than ${IDEA_REJECT_GOOD_BELOW} can be rejected.`;
}
