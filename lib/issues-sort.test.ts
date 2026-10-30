import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUG_SORT_OPTIONS,
  DEFAULT_BUG_SORT,
  bugSortDescriptions,
  bugSortLabels,
  compareBugsByLowestVotes,
  compareBugsByNewest,
  compareBugsByPopularity,
  SEVERITY_RANK,
  getBugOrderBy,
  parseBugSort,
  sortBugs,
  sortBugsByPopularity,
} from "./issues-sort";

describe("sort options constants and labels", () => {
  it("lists every option, with importance still the default", () => {
    expect(BUG_SORT_OPTIONS).toEqual([
      "newest",
      "recently_updated",
      "importance",
      "least_important",
      "severity",
    ]);
    expect(DEFAULT_BUG_SORT).toBe("importance");
  });

  it("labels the importance sorts (#importance)", () => {
    expect(bugSortLabels.importance).toBe("Most important");
    expect(bugSortLabels.least_important).toBe("Least important");
  });

  it("has a label and a description for every option", () => {
    for (const option of BUG_SORT_OPTIONS) {
      expect(bugSortLabels[option], option).toBeTruthy();
      expect(bugSortDescriptions[option], option).toBeTruthy();
    }
    expect(Object.keys(bugSortLabels).sort()).toEqual([...BUG_SORT_OPTIONS].sort());
    expect(Object.keys(bugSortDescriptions).sort()).toEqual([...BUG_SORT_OPTIONS].sort());
  });
});

describe("parseBugSort", () => {
  it("defaults to importance when undefined, null, empty, or whitespace", () => {
    expect(parseBugSort(undefined)).toBe("importance");
    expect(parseBugSort(null)).toBe("importance");
    expect(parseBugSort("")).toBe("importance");
    expect(parseBugSort("   ")).toBe("importance");
  });

  it("defaults to importance for unrecognized sort options", () => {
    expect(parseBugSort("invalid")).toBe("importance");
    expect(parseBugSort("random_sort")).toBe("importance");
  });

  it("parses newest variants", () => {
    expect(parseBugSort("newest")).toBe("newest");
    expect(parseBugSort("NEWEST")).toBe("newest");
    expect(parseBugSort("new")).toBe("newest");
  });

  it("parses importance variants (#importance)", () => {
    expect(parseBugSort("importance")).toBe("importance");
    expect(parseBugSort("most-important")).toBe("importance");
    expect(parseBugSort("important")).toBe("importance");
  });

  it("keeps the old top_votes links working as importance", () => {
    expect(parseBugSort("top_votes")).toBe("importance");
    expect(parseBugSort("top-votes")).toBe("importance");
    expect(parseBugSort("top")).toBe("importance");
    expect(parseBugSort("votes_desc")).toBe("importance");
  });

  it("parses least_important; the old vote names are gone", () => {
    expect(parseBugSort("least_important")).toBe("least_important");
    expect(parseBugSort("least-important")).toBe("least_important");
    expect(parseBugSort("lowest_votes")).toBe("importance");
    expect(parseBugSort("votes_asc")).toBe("importance");
  });

  it("handles repeated query parameters as string array without throwing", () => {
    expect(parseBugSort(["newest", "importance"])).toBe("newest");
    expect(parseBugSort(["importance", "least_important"])).toBe("importance");
    expect(parseBugSort(["least_important", "newest"])).toBe("least_important");
    expect(parseBugSort([])).toBe("importance");
  });
});

describe("getBugOrderBy", () => {
  it("returns isBoosted desc, boostedAt desc, and createdAt desc for newest", () => {
    expect(getBugOrderBy("newest")).toEqual([
      { isBoosted: "desc" },
      { boostedAt: "desc" },
      { createdAt: "desc" },
      { id: "desc" },
    ]);
  });

  it("returns isBoosted desc, boostedAt desc, and voteCount desc for importance", () => {
    expect(getBugOrderBy("importance")).toEqual([
      { isBoosted: "desc" },
      { boostedAt: "desc" },
      { voteCount: "desc" },
      { updatedAt: "desc" },
      { createdAt: "desc" },
    ]);
  });

  it("returns isBoosted desc, boostedAt desc, and voteCount asc for least_important", () => {
    expect(getBugOrderBy("least_important")).toEqual([
      { isBoosted: "desc" },
      { boostedAt: "desc" },
      { voteCount: "asc" },
      { updatedAt: "desc" },
      { createdAt: "desc" },
    ]);
  });
});

describe("compareBugsByPopularity", () => {
  it("orders higher voteCount first", () => {
    expect(
      compareBugsByPopularity(
        { voteCount: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
        { voteCount: 5, updatedAt: "2026-01-01T00:00:00.000Z" },
      ),
    ).toBeGreaterThan(0);
  });

  it("uses updatedAt as tiebreaker when voteCounts match", () => {
    expect(
      compareBugsByPopularity(
        { voteCount: 2, updatedAt: "2026-01-01T00:00:00.000Z" },
        { voteCount: 2, updatedAt: "2026-01-02T00:00:00.000Z" },
      ),
    ).toBeGreaterThan(0);
  });
});

describe("compareBugsByLowestVotes", () => {
  it("orders lower voteCount first", () => {
    expect(
      compareBugsByLowestVotes(
        { voteCount: 5, updatedAt: "2026-01-01T00:00:00.000Z" },
        { voteCount: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
      ),
    ).toBeGreaterThan(0);
  });

  it("uses updatedAt as tiebreaker when voteCounts match", () => {
    expect(
      compareBugsByLowestVotes(
        { voteCount: 2, updatedAt: "2026-01-01T00:00:00.000Z" },
        { voteCount: 2, updatedAt: "2026-01-02T00:00:00.000Z" },
      ),
    ).toBeGreaterThan(0);
  });
});

describe("compareBugsByNewest", () => {
  it("orders more recent createdAt first", () => {
    expect(
      compareBugsByNewest(
        { createdAt: "2026-01-01T00:00:00.000Z" },
        { createdAt: "2026-01-05T00:00:00.000Z" },
      ),
    ).toBeGreaterThan(0);
  });

  it("uses id as tiebreaker when createdAt matches", () => {
    expect(
      compareBugsByNewest(
        { id: "a", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "b", createdAt: "2026-01-01T00:00:00.000Z" },
      ),
    ).toBeGreaterThan(0);
  });
});

describe("sortBugsByPopularity", () => {
  it("returns bugs sorted by votes then updatedAt", () => {
    const sorted = sortBugsByPopularity([
      { id: "a", voteCount: 1, updatedAt: "2026-01-03T00:00:00.000Z" },
      { id: "b", voteCount: 3, updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "c", voteCount: 3, updatedAt: "2026-01-02T00:00:00.000Z" },
      { id: "d", voteCount: 0, updatedAt: "2026-01-04T00:00:00.000Z" },
    ]);

    expect(sorted.map((bug) => bug.id)).toEqual(["c", "b", "a", "d"]);
  });
});

describe("sortBugs", () => {
  const sampleBugs = [
    {
      id: "a",
      voteCount: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-05T00:00:00.000Z",
    },
    {
      id: "b",
      voteCount: 5,
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    },
    {
      id: "c",
      voteCount: 0,
      createdAt: "2026-01-04T00:00:00.000Z",
      updatedAt: "2026-01-04T00:00:00.000Z",
    },
    {
      id: "d",
      voteCount: 5,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-06T00:00:00.000Z",
    },
  ];

  it("sorts by newest (createdAt descending)", () => {
    const sorted = sortBugs(sampleBugs, "newest");
    expect(sorted.map((b) => b.id)).toEqual(["c", "b", "d", "a"]);
  });

  it("sorts by importance (voteCount descending with updatedAt tiebreaker)", () => {
    const sorted = sortBugs(sampleBugs, "importance");
    expect(sorted.map((b) => b.id)).toEqual(["d", "b", "a", "c"]);
  });

  it("sorts by least_important (voteCount ascending with updatedAt tiebreaker)", () => {
    const sorted = sortBugs(sampleBugs, "least_important");
    expect(sorted.map((b) => b.id)).toEqual(["c", "a", "d", "b"]);
  });

  it("always puts boosted tickets at the top regardless of votes or sort option", () => {
    const bugsWithBoost = [
      { id: "regular-high-votes", voteCount: 100, isBoosted: false, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "boosted-low-votes", voteCount: 0, isBoosted: true, boostedAt: "2026-01-10T00:00:00.000Z", createdAt: "2026-01-02T00:00:00.000Z" },
      { id: "regular-recent", voteCount: 5, isBoosted: false, createdAt: "2026-01-20T00:00:00.000Z" },
    ];

    const sortedByVotes = sortBugs(bugsWithBoost, "importance");
    expect(sortedByVotes[0].id).toBe("boosted-low-votes");

    const sortedByNewest = sortBugs(bugsWithBoost, "newest");
    expect(sortedByNewest[0].id).toBe("boosted-low-votes");
  });

  it("orders multiple boosted tickets by boostedAt descending", () => {
    const multipleBoosted = [
      { id: "boosted-first", isBoosted: true, boostedAt: "2026-01-01T00:00:00.000Z", voteCount: 10, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "boosted-latest", isBoosted: true, boostedAt: "2026-01-05T00:00:00.000Z", voteCount: 2, createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    const sorted = sortBugs(multipleBoosted, "importance");
    expect(sorted.map((b) => b.id)).toEqual(["boosted-latest", "boosted-first"]);
  });
});

describe("severity sort", () => {
  it("matches the Severity enum declaration order", () => {
    // `orderBy: { severity: "desc" }` relies on Postgres ordering the enum by
    // declaration order, so the schema and SEVERITY_RANK have to agree.
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const members = schema
      .match(/enum Severity \{([^}]*)\}/)![1]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(members).toEqual(["low", "medium", "high", "critical"]);
    const ranked = [...members].sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b]);
    expect(ranked).toEqual(members);
  });

  it("puts the most severe first", () => {
    const made = (severity: string, voteCount = 0) => ({
      severity,
      voteCount,
      createdAt: new Date("2026-01-01"),
    });
    const sorted = sortBugs(
      [made("medium"), made("critical"), made("low"), made("high")],
      "severity",
    );
    expect(sorted.map((b) => b.severity)).toEqual([
      "critical",
      "high",
      "medium",
      "low",
    ]);
  });

  it("breaks ties on votes, then recency", () => {
    const at = (iso: string, voteCount: number) => ({
      severity: "high",
      voteCount,
      createdAt: new Date(iso),
    });
    const sorted = sortBugs([at("2026-01-01", 2), at("2026-03-01", 2), at("2026-01-01", 9)], "severity");
    expect(sorted.map((b) => [b.voteCount, b.createdAt.getUTCMonth()])).toEqual([
      [9, 0],
      [2, 2],
      [2, 0],
    ]);
  });

  it("still puts boosted issues on top", () => {
    const sorted = sortBugs(
      [
        { severity: "critical", voteCount: 0, createdAt: new Date("2026-01-01") },
        { severity: "low", voteCount: 0, createdAt: new Date("2026-01-01"), isBoosted: true },
      ],
      "severity",
    );
    expect(sorted[0].severity).toBe("low");
  });
});

describe("recently updated sort", () => {
  it("puts the most recently updated first", () => {
    const made = (id: string, updatedAt: string) => ({
      id,
      voteCount: 0,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date(updatedAt),
    });
    const sorted = sortBugs(
      [made("a", "2026-02-01"), made("b", "2026-05-01"), made("c", "2026-03-01")],
      "recently_updated",
    );
    expect(sorted.map((b) => b.id)).toEqual(["b", "c", "a"]);
  });

  it("falls back to createdAt when an item has never been updated", () => {
    const sorted = sortBugs(
      [
        { id: "old", voteCount: 0, createdAt: new Date("2026-01-01") },
        { id: "new", voteCount: 0, createdAt: new Date("2026-06-01") },
      ],
      "recently_updated",
    );
    expect(sorted.map((b) => b.id)).toEqual(["new", "old"]);
  });
});

describe("parseBugSort for the new options", () => {
  it("accepts the new keys and their aliases", () => {
    expect(parseBugSort("recently_updated")).toBe("recently_updated");
    expect(parseBugSort("recently-updated")).toBe("recently_updated");
    expect(parseBugSort("updated")).toBe("recently_updated");
    expect(parseBugSort("severity")).toBe("severity");
    expect(parseBugSort("most_severe")).toBe("severity");
  });

  it("still defaults to importance for anything unknown", () => {
    expect(parseBugSort("sideways")).toBe("importance");
  });
});

describe("getBugOrderBy for the new options", () => {
  it("orders by updatedAt, after boosts", () => {
    expect(getBugOrderBy("recently_updated")).toEqual([
      { isBoosted: "desc" },
      { boostedAt: "desc" },
      { updatedAt: "desc" },
      { id: "desc" },
    ]);
  });

  it("orders by severity descending, after boosts", () => {
    expect(getBugOrderBy("severity")[2]).toEqual({ severity: "desc" });
  });
});
