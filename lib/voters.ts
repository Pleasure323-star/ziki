export type VoterInfo = {
  id: string;
  name: string;
  image: string | null;
};

export type VoterBucket = {
  count: number;
  voters: VoterInfo[];
};

export type BugVoterSummary = {
  likes: VoterBucket;
  dislikes: VoterBucket;
};

export type VoteCounts = {
  likeCount: number;
  dislikeCount: number;
};

/** Faces drawn in the avatar stack before the "+N" badge. */
export const VISIBLE_VOTERS = 3;
/** Names listed when hovering or tapping the "+N" badge (#408). */
export const LISTED_OVERFLOW_VOTERS = 10;
/** Voters loaded per like/dislike bucket: the faces plus the named overflow. */
export const FETCHED_VOTERS = VISIBLE_VOTERS + LISTED_OVERFLOW_VOTERS;

export type OverflowVoters = {
  /** Names of the voters hidden behind the "+N" badge, in avatar order. */
  names: string[];
  /** Hidden voters beyond the listed names ("and N others"). */
  others: number;
};

/**
 * Who the "+N" badge stands for: the voters after the visible faces, up to
 * `maxListed` names, and how many more there are beyond those (#408).
 * Returns null when every voter already has a face.
 *
 * If fewer voters were loaded than the count says, the shortfall is counted
 * in `others`, so the badge still adds up rather than listing nobody.
 */
export function getOverflowVoters(
  voters: VoterInfo[],
  totalCount: number,
  maxVisible: number = VISIBLE_VOTERS,
  maxListed: number = LISTED_OVERFLOW_VOTERS,
): OverflowVoters | null {
  const hidden = totalCount - maxVisible;
  if (hidden <= 0) return null;

  const names = voters
    .slice(maxVisible, maxVisible + Math.min(maxListed, hidden))
    .map((voter) => voter.name?.trim() || "Unnamed user");

  return { names, others: hidden - names.length };
}

/**
 * One line for assistive tech and the badge's label:
 * "Also marked important: Ada, Bea and 2 others".
 */
export function describeOverflowVoters({ names, others }: OverflowVoters): string {
  const othersText = `${others} ${others === 1 ? "other" : "others"}`;
  if (names.length === 0) return `${othersText} marked it important`;
  if (others === 0) {
    if (names.length === 1) return `Also marked important: ${names[0]}`;
    return `Also marked important: ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `Also marked important: ${names.join(", ")} and ${othersText}`;
}

export function createEmptyVoterSummary(): BugVoterSummary {
  return {
    likes: { count: 0, voters: [] },
    dislikes: { count: 0, voters: [] },
  };
}

/**
 * Extracts display initials from a user's name.
 * Examples:
 * - "Goodness Mbakara" -> "GM"
 * - "Alice" -> "A"
 * - "John Doe Smith" -> "JS"
 * - empty/null/undefined -> "?"
 */
export function getInitials(name?: string | null): string {
  if (!name || !name.trim()) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    return parts[0].slice(0, 1).toUpperCase();
  }
  const first = parts[0][0];
  const last = parts[parts.length - 1][0];
  return `${first}${last}`.toUpperCase();
}

/**
 * Formats the "+N" overflow label when totalCount exceeds maxVisible.
 * Returns null if count <= maxVisible or count is 0.
 * Examples with maxVisible = 3:
 * - 0 -> null
 * - 3 -> null
 * - 4 -> "+1"
 * - 500 -> "+497"
 */
export function formatOverflowCount(
  count: number,
  maxVisible: number = 3,
): string | null {
  if (count <= maxVisible) return null;
  return `+${count - maxVisible}`;
}

/**
 * Calculates updated like/dislike counts and next vote state
 * when clicking a reaction (1 = like, -1 = dislike).
 */
export function updateVoteCounts(
  counts: VoteCounts,
  currentVote: number | null | undefined,
  direction: 1 | -1,
): VoteCounts & { nextVote: 1 | -1 | 0 } {
  const current: 1 | -1 | 0 =
    currentVote === 1 ? 1 : currentVote === -1 ? -1 : 0;
  let likeCount = Math.max(0, counts.likeCount);
  let dislikeCount = Math.max(0, counts.dislikeCount);

  if (current === direction) {
    // Clicking active reaction removes it
    if (direction === 1) {
      likeCount = Math.max(0, likeCount - 1);
    } else {
      dislikeCount = Math.max(0, dislikeCount - 1);
    }
    return {
      likeCount,
      dislikeCount,
      nextVote: 0,
    };
  }

  if (current === 0) {
    // Fresh reaction
    if (direction === 1) {
      likeCount += 1;
    } else {
      dislikeCount += 1;
    }
    return {
      likeCount,
      dislikeCount,
      nextVote: direction,
    };
  }

  // Switching vote (+1 to -1 or -1 to +1)
  if (direction === 1) {
    dislikeCount = Math.max(0, dislikeCount - 1);
    likeCount += 1;
  } else {
    likeCount = Math.max(0, likeCount - 1);
    dislikeCount += 1;
  }

  return {
    likeCount,
    dislikeCount,
    nextVote: direction,
  };
}

export type RawVoterRow = {
  bugId: string;
  value: number;
  userId: string;
  name: string;
  image: string | null;
  total_count: number | bigint | string;
  rn: number | bigint | string;
};

/**
 * Builds a Map of bugId -> BugVoterSummary from raw SQL voter rows.
 */
export function buildVoterSummaries(
  rows: RawVoterRow[],
  bugIds?: string[],
): Map<string, BugVoterSummary> {
  const map = new Map<string, BugVoterSummary>();

  if (bugIds) {
    for (const id of bugIds) {
      map.set(id, createEmptyVoterSummary());
    }
  }

  for (const row of rows) {
    let summary = map.get(row.bugId);
    if (!summary) {
      summary = createEmptyVoterSummary();
      map.set(row.bugId, summary);
    }

    const bucket =
      row.value > 0
        ? summary.likes
        : row.value < 0
          ? summary.dislikes
          : null;
    if (!bucket) continue;

    bucket.count = Number(row.total_count);
    if (Number(row.rn) <= FETCHED_VOTERS) {
      bucket.voters.push({
        id: row.userId,
        name: row.name,
        image: row.image,
      });
    }
  }

  return map;
}

export function buildVoterSummary(rows: RawVoterRow[]): BugVoterSummary {
  const map = buildVoterSummaries(rows);
  return map.values().next().value ?? createEmptyVoterSummary();
}
