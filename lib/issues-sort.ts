import type { Prisma } from "@prisma/client";

export const BUG_SORT_OPTIONS = [
  "newest",
  "recently_updated",
  "importance",
  "least_important",
  "severity",
] as const;
export type BugSortOption = (typeof BUG_SORT_OPTIONS)[number];

/** #importance: upvotes are now Importance; the most important issues come first. */
export const DEFAULT_BUG_SORT: BugSortOption = "importance";

export const bugSortLabels: Record<BugSortOption, string> = {
  newest: "Newest",
  recently_updated: "Recently Updated",
  importance: "Most important",
  least_important: "Least important",
  severity: "Most Severe",
};

export const bugSortDescriptions: Record<BugSortOption, string> = {
  newest: "newest",
  recently_updated: "recently updated",
  importance: "most important",
  least_important: "least important",
  severity: "most severe",
};

/**
 * Severity is a Prisma enum, and Postgres orders enums by declaration order.
 * Severity is declared low -> critical, so "desc" is critical first. A test
 * pins that, because reordering the enum would silently invert this sort.
 */
export const SEVERITY_RANK: Record<string, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

/** Sort key for bug lists: most important first, then most recently updated. */
export type BugPopularitySortKey = {
  voteCount: number;
  updatedAt: Date | string;
};

export function isBugSortOption(value: unknown): value is BugSortOption {
  return (
    typeof value === "string" &&
    (BUG_SORT_OPTIONS as readonly string[]).includes(value)
  );
}

export function parseBugSort(
  raw?: string | string[] | null,
  /** What to use when the value is missing or unrecognised. */
  fallback: BugSortOption = DEFAULT_BUG_SORT,
): BugSortOption {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "newest" || normalized === "new") {
    return "newest";
  }
  if (
    normalized === "recently_updated" ||
    normalized === "updated" ||
    normalized === "recent"
  ) {
    return "recently_updated";
  }
  if (
    normalized === "severity" ||
    normalized === "most_severe" ||
    normalized === "severity_desc"
  ) {
    return "severity";
  }
  // #importance: `top_votes` and `lowest_votes` were the names before
  // upvotes became Importance; old links keep working.
  if (
    normalized === "importance" ||
    normalized === "most_important" ||
    normalized === "important" ||
    normalized === "top_votes" ||
    normalized === "top" ||
    normalized === "topvotes" ||
    normalized === "votes_desc"
  ) {
    return "importance";
  }
  if (
    normalized === "least_important" ||
    normalized === "least_importance" ||
    normalized === "importance_asc" ||
    normalized === "lowest_votes" ||
    normalized === "lowest" ||
    normalized === "lowestvotes" ||
    normalized === "votes_asc"
  ) {
    return "least_important";
  }
  return fallback;
}

export function getBugOrderBy(
  sort: BugSortOption,
  /** Boosted issues pin to the top. Off for a personal list (#312). */
  { boostFirst = true }: { boostFirst?: boolean } = {},
): Prisma.BugOrderByWithRelationInput[] {
  const baseOrder: Prisma.BugOrderByWithRelationInput[] = (() => {
    switch (sort) {
      case "newest":
        return [{ createdAt: "desc" }, { id: "desc" }];
      case "recently_updated":
        return [{ updatedAt: "desc" }, { id: "desc" }];
      case "severity":
        // Ties fall back to the default ordering so the list stays stable.
        return [
          { severity: "desc" },
          { voteCount: "desc" },
          { createdAt: "desc" },
        ];
      case "importance":
        return [
          { voteCount: "desc" },
          { updatedAt: "desc" },
          { createdAt: "desc" },
        ];
      case "least_important":
        return [
          { voteCount: "asc" },
          { updatedAt: "desc" },
          { createdAt: "desc" },
        ];
    }
  })();

  // Boosted tickets always take precedence at the top, followed by active sort
  return boostFirst
    ? [{ isBoosted: "desc" }, { boostedAt: "desc" }, ...baseOrder]
    : baseOrder;
}

export function compareBoosted<
  T extends { isBoosted?: boolean; boostedAt?: Date | string | null },
>(a: T, b: T): number {
  const aBoosted = Boolean(a.isBoosted);
  const bBoosted = Boolean(b.isBoosted);
  if (aBoosted !== bBoosted) {
    return aBoosted ? -1 : 1;
  }
  if (aBoosted && bBoosted) {
    const aTime = a.boostedAt ? new Date(a.boostedAt).getTime() : 0;
    const bTime = b.boostedAt ? new Date(b.boostedAt).getTime() : 0;
    if (bTime !== aTime) return bTime - aTime;
  }
  return 0;
}

export function compareBugsByPopularity(
  a: BugPopularitySortKey,
  b: BugPopularitySortKey,
): number {
  if (b.voteCount !== a.voteCount) {
    return b.voteCount - a.voteCount;
  }
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

export function compareBugsByLowestVotes(
  a: BugPopularitySortKey,
  b: BugPopularitySortKey,
): number {
  if (a.voteCount !== b.voteCount) {
    return a.voteCount - b.voteCount;
  }
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

export function compareBugsByNewest(
  a: { createdAt: Date | string; id?: string },
  b: { createdAt: Date | string; id?: string },
): number {
  const diff =
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  if (diff !== 0) return diff;
  if (a.id && b.id) return b.id.localeCompare(a.id);
  return 0;
}

export function compareBugsByRecentlyUpdated(
  a: { updatedAt?: Date | string; createdAt: Date | string; id?: string },
  b: { updatedAt?: Date | string; createdAt: Date | string; id?: string },
): number {
  const diff =
    new Date(b.updatedAt ?? b.createdAt).getTime() -
    new Date(a.updatedAt ?? a.createdAt).getTime();
  if (diff !== 0) return diff;
  if (a.id && b.id) return b.id.localeCompare(a.id);
  return 0;
}

export function compareBugsBySeverity(
  a: { severity?: string; voteCount: number; createdAt: Date | string },
  b: { severity?: string; voteCount: number; createdAt: Date | string },
): number {
  const rank = (s?: string) => SEVERITY_RANK[s ?? ""] ?? -1;
  const diff = rank(b.severity) - rank(a.severity);
  if (diff !== 0) return diff;
  if (b.voteCount !== a.voteCount) return b.voteCount - a.voteCount;
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

export type BugSortableItem = {
  id?: string;
  severity?: string;
  voteCount: number;
  isBoosted?: boolean;
  boostedAt?: Date | string | null;
  createdAt: Date | string;
  updatedAt?: Date | string;
};

export function sortBugsByPopularity<T extends BugPopularitySortKey>(
  bugs: T[],
): T[] {
  return [...bugs].sort(compareBugsByPopularity);
}

export function sortBugs<T extends BugSortableItem>(
  bugs: T[],
  sort: BugSortOption,
): T[] {
  return [...bugs].sort((a, b) => {
    const boostDiff = compareBoosted(a, b);
    if (boostDiff !== 0) return boostDiff;
    switch (sort) {
      case "newest":
        return compareBugsByNewest(a, b);
      case "recently_updated":
        return compareBugsByRecentlyUpdated(a, b);
      case "severity":
        return compareBugsBySeverity(a, b);
      case "importance":
        return compareBugsByPopularity(
          { voteCount: a.voteCount, updatedAt: a.updatedAt ?? a.createdAt },
          { voteCount: b.voteCount, updatedAt: b.updatedAt ?? b.createdAt },
        );
      case "least_important":
        return compareBugsByLowestVotes(
          { voteCount: a.voteCount, updatedAt: a.updatedAt ?? a.createdAt },
          { voteCount: b.voteCount, updatedAt: b.updatedAt ?? b.createdAt },
        );
    }
  });
}
