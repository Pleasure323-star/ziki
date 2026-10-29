export type VoteChange = {
  nextVote: 1 | -1 | 0;
  countDelta: number;
};

/** Validates vote direction: only 1 (like) and -1 (dislike) are supported; out-of-range or malformed values are rejected. */
export function isValidVoteDirection(direction: unknown): direction is 1 | -1 {
  return direction === 1 || direction === -1;
}

/**
 * Pure helper for calculating score changes and next vote state
 * when upvoting (direction = 1) or downvoting (direction = -1).
 */
export function calculateVoteChange(
  currentVote: number | null | undefined,
  direction: 1 | -1,
): VoteChange {
  const current = voteDirection(currentVote);

  if (current === direction) {
    // Toggle off existing vote
    return {
      nextVote: 0,
      countDelta: -direction,
    };
  }

  if (current === 0) {
    // Fresh vote from neutral
    return {
      nextVote: direction,
      countDelta: direction,
    };
  }

  // Switching vote (+1 to -1 or -1 to +1)
  return {
    nextVote: direction,
    countDelta: direction * 2,
  };
}

/**
 * The authoritative Bug.voteCount: the number of upvotes (#1059). It used to
 * be SUM(Vote.value), so every old dislike took one away.
 */
export function reconcileVoteCount(
  likeCount: number,
  // #1059: downvotes are gone. Old dislike rows are kept but no longer count
  // against an issue, so the stored count is its upvotes.
  _dislikeCount: number,
): number {
  void _dislikeCount;
  return likeCount;
}

/**
 * A manager or merger agent's upvote is stored as this `Vote.value`, so it
 * counts as this many upvotes. Everyone else's upvote is 1.
 */
export const MANAGER_VOTE_WEIGHT = 5;

/** The direction of a stored vote: any positive value is an upvote. */
export function voteDirection(value: number | null | undefined): 1 | -1 | 0 {
  if (typeof value !== "number" || value === 0) return 0;
  return value > 0 ? 1 : -1;
}

/**
 * Upvotes and old dislikes from `vote.groupBy({ by: ["value"] })`. An upvote
 * counts as its value (1, or MANAGER_VOTE_WEIGHT); a dislike counts once.
 */
export function tallyVoteGroups(
  groups: ReadonlyArray<{ value: number; _count: { _all: number } }>,
): { likeCount: number; dislikeCount: number } {
  let likeCount = 0;
  let dislikeCount = 0;
  for (const group of groups) {
    if (group.value > 0) likeCount += group.value * group._count._all;
    if (group.value < 0) dislikeCount += group._count._all;
  }
  return { likeCount, dislikeCount };
}

/** #1059: what a downvote attempt is told. */
export const DOWNVOTES_REMOVED_MESSAGE =
  "Downvotes were removed. Mark issues that matter as important, or say what's wrong in a reply.";

