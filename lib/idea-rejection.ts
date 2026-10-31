import type { IdeaOpinion } from "@prisma/client";

/**
 * When an idea is bad (#idea-rejected): it has had a fair hearing — its votes
 * reach the project's idea threshold — and its bad and neutral votes outnumber
 * its good ones. A bad idea shows in red, and manager agents are advised to
 * reject it. With a threshold of 3, one good, one neutral and one bad vote
 * make a bad idea. Votes are the verdicts' weights (a person's verdict is 1
 * vote, a manager agent's up to the project's managerVoteWeight), the same votes the idea's score adds up.
 */
export type IdeaVotes = {
  total: number;
  good: number;
  /** How many people gave verdicts: each person gives an idea one verdict. */
  people?: number;
};

/** All the votes an idea's verdicts carry, how many of them are good, and how many people gave them. */
export function ideaVotes(verdicts: Iterable<{ opinion: IdeaOpinion | string; votes: number }>): IdeaVotes {
  let total = 0;
  let good = 0;
  let people = 0;
  for (const verdict of verdicts) {
    total += verdict.votes;
    people += 1;
    if (verdict.opinion === "good") good += verdict.votes;
  }
  return { total, good, people };
}

/** Bad: enough votes to judge, and more bad or neutral than good. */
export function isBadIdea(votes: IdeaVotes, threshold: number): boolean {
  return votes.total >= threshold && votes.total - votes.good > votes.good;
}

/**
 * The fewest people whose verdicts may reject an idea automatically
 * (#vote-governance). In a threshold-only project one manager agent's verdict
 * can carry the whole threshold, so a bad idea is rejected on its own only
 * once at least two different people gave it verdicts. A manager agent's
 * reject in a manager-governed project is a decision, not a tally, and keeps
 * the plain `isBadIdea` rule.
 */
export const AUTO_REJECT_MIN_PEOPLE = 2;

/** Bad, and judged by at least `AUTO_REJECT_MIN_PEOPLE` people: what a threshold-only project rejects on its own. */
export function isAutoRejectable(votes: IdeaVotes, threshold: number): boolean {
  return isBadIdea(votes, threshold) && (votes.people ?? 0) >= AUTO_REJECT_MIN_PEOPLE;
}

/** Why an idea isn't bad (and so can't be rejected), in a sentence. */
export function notRejectableReason(votes: IdeaVotes, threshold: number): string {
  if (votes.total < threshold) {
    return `This idea has ${votes.total} vote${votes.total === 1 ? "" : "s"}; it can be rejected once it has ${threshold}.`;
  }
  return `This idea has ${votes.good} good vote${votes.good === 1 ? "" : "s"} of ${votes.total}; it can be rejected only when its bad and neutral votes outnumber its good ones.`;
}
