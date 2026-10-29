import { describe, expect, it } from "vitest";
import {
  buildVoterSummaries,
  buildVoterSummary,
  createEmptyVoterSummary,
  describeOverflowVoters,
  FETCHED_VOTERS,
  formatOverflowCount,
  getInitials,
  getOverflowVoters,
  updateVoteCounts,
  type RawVoterRow,
  type VoterInfo,
} from "./voters";

const people = (n: number): VoterInfo[] =>
  Array.from({ length: n }, (_, i) => ({ id: `u${i + 1}`, name: `User ${i + 1}`, image: null }));

describe("getOverflowVoters (#408)", () => {
  it("is null when every voter already has a face", () => {
    expect(getOverflowVoters(people(3), 3)).toBeNull();
    expect(getOverflowVoters([], 0)).toBeNull();
  });

  it("names the voters after the first three, in order", () => {
    // #144: 11 likes, 3 faces, "+8".
    expect(getOverflowVoters(people(11), 11)).toEqual({
      names: ["User 4", "User 5", "User 6", "User 7", "User 8", "User 9", "User 10", "User 11"],
      others: 0,
    });
  });

  it("lists at most ten names and counts the rest", () => {
    const overflow = getOverflowVoters(people(FETCHED_VOTERS), 40)!;
    expect(overflow.names).toHaveLength(10);
    expect(overflow.names[0]).toBe("User 4");
    expect(overflow.others).toBe(27);
  });

  it("still adds up when fewer voters were loaded than the count", () => {
    // e.g. a vote landed between the count and the list, or none were loaded.
    expect(getOverflowVoters(people(3), 8)).toEqual({ names: [], others: 5 });
    expect(getOverflowVoters(people(5), 8)).toEqual({ names: ["User 4", "User 5"], others: 3 });
  });

  it("doesn't list a voter twice when more were loaded than the count", () => {
    expect(getOverflowVoters(people(6), 4)).toEqual({ names: ["User 4"], others: 0 });
  });

  it("gives a blank name something to show", () => {
    const voters = [...people(3), { id: "x", name: "  ", image: null }];
    expect(getOverflowVoters(voters, 4)!.names).toEqual(["Unnamed user"]);
  });
});

describe("describeOverflowVoters (#408)", () => {
  it("joins names like a sentence", () => {
    expect(describeOverflowVoters({ names: ["Ada"], others: 0 })).toBe("Also marked important: Ada");
    expect(describeOverflowVoters({ names: ["Ada", "Bea", "Cal"], others: 0 })).toBe(
      "Also marked important: Ada, Bea and Cal",
    );
  });

  it("adds the voters beyond the list", () => {
    expect(describeOverflowVoters({ names: ["Ada", "Bea"], others: 1 })).toBe(
      "Also marked important: Ada, Bea and 1 other",
    );
    expect(describeOverflowVoters({ names: ["Ada"], others: 5 })).toBe("Also marked important: Ada and 5 others");
  });

  it("falls back to a count when no names were loaded", () => {
    expect(describeOverflowVoters({ names: [], others: 5 })).toBe("5 others marked it important");
  });
});

describe("getInitials", () => {
  it("extracts initials from multi-word names", () => {
    expect(getInitials("Goodness Mbakara")).toBe("GM");
    expect(getInitials("John Doe Smith")).toBe("JS");
    expect(getInitials("jane mary doe")).toBe("JD");
  });

  it("extracts initial from single-word names", () => {
    expect(getInitials("Alice")).toBe("A");
    expect(getInitials("bob")).toBe("B");
  });

  it("handles whitespace correctly", () => {
    expect(getInitials("   Goodness    Mbakara   ")).toBe("GM");
  });

  it("returns ? for missing or empty names", () => {
    expect(getInitials("")).toBe("?");
    expect(getInitials("   ")).toBe("?");
    expect(getInitials(null)).toBe("?");
    expect(getInitials(undefined)).toBe("?");
  });
});

describe("formatOverflowCount", () => {
  it("returns null when count is less than or equal to maxVisible", () => {
    expect(formatOverflowCount(0, 3)).toBeNull();
    expect(formatOverflowCount(1, 3)).toBeNull();
    expect(formatOverflowCount(2, 3)).toBeNull();
    expect(formatOverflowCount(3, 3)).toBeNull();
  });

  it("formats overflow when count exceeds maxVisible", () => {
    expect(formatOverflowCount(4, 3)).toBe("+1");
    expect(formatOverflowCount(5, 3)).toBe("+2");
    expect(formatOverflowCount(500, 3)).toBe("+497");
  });

  it("supports custom maxVisible", () => {
    expect(formatOverflowCount(5, 5)).toBeNull();
    expect(formatOverflowCount(6, 5)).toBe("+1");
  });
});

describe("updateVoteCounts", () => {
  it("adds like from neutral", () => {
    const res = updateVoteCounts({ likeCount: 5, dislikeCount: 2 }, 0, 1);
    expect(res).toEqual({
      likeCount: 6,
      dislikeCount: 2,
      nextVote: 1,
    });
  });

  it("adds dislike from neutral", () => {
    const res = updateVoteCounts({ likeCount: 5, dislikeCount: 2 }, 0, -1);
    expect(res).toEqual({
      likeCount: 5,
      dislikeCount: 3,
      nextVote: -1,
    });
  });

  it("toggles off like", () => {
    const res = updateVoteCounts({ likeCount: 5, dislikeCount: 2 }, 1, 1);
    expect(res).toEqual({
      likeCount: 4,
      dislikeCount: 2,
      nextVote: 0,
    });
  });

  it("toggles off dislike", () => {
    const res = updateVoteCounts({ likeCount: 5, dislikeCount: 2 }, -1, -1);
    expect(res).toEqual({
      likeCount: 5,
      dislikeCount: 1,
      nextVote: 0,
    });
  });

  it("switches from like to dislike", () => {
    const res = updateVoteCounts({ likeCount: 5, dislikeCount: 2 }, 1, -1);
    expect(res).toEqual({
      likeCount: 4,
      dislikeCount: 3,
      nextVote: -1,
    });
  });

  it("switches from dislike to like", () => {
    const res = updateVoteCounts({ likeCount: 5, dislikeCount: 2 }, -1, 1);
    expect(res).toEqual({
      likeCount: 6,
      dislikeCount: 1,
      nextVote: 1,
    });
  });

  it("clamps negative numbers to 0", () => {
    const res = updateVoteCounts({ likeCount: 0, dislikeCount: 0 }, 1, 1);
    expect(res).toEqual({
      likeCount: 0,
      dislikeCount: 0,
      nextVote: 0,
    });
  });
});

describe("buildVoterSummaries", () => {
  it("initializes empty summaries for all requested bugIds", () => {
    const map = buildVoterSummaries([], ["bug-1", "bug-2"]);
    expect(map.get("bug-1")).toEqual(createEmptyVoterSummary());
    expect(map.get("bug-2")).toEqual(createEmptyVoterSummary());
  });

  it("groups up to 3 voters and sets total count", () => {
    const rows: RawVoterRow[] = [
      {
        bugId: "bug-1",
        value: 1,
        userId: "u-1",
        name: "User One",
        image: "https://example.com/1.png",
        total_count: 5,
        rn: 1,
      },
      {
        bugId: "bug-1",
        value: 1,
        userId: "u-2",
        name: "User Two",
        image: null,
        total_count: 5,
        rn: 2,
      },
      {
        bugId: "bug-1",
        value: 1,
        userId: "u-3",
        name: "User Three",
        image: "https://example.com/3.png",
        total_count: 5,
        rn: 3,
      },
      {
        bugId: "bug-1",
        value: -1,
        userId: "u-4",
        name: "User Four",
        image: null,
        total_count: 1,
        rn: 1,
      },
    ];

    const summary = buildVoterSummary(rows);
    expect(summary.likes.count).toBe(5);
    expect(summary.likes.voters).toHaveLength(3);
    expect(summary.likes.voters[0]).toEqual({
      id: "u-1",
      name: "User One",
      image: "https://example.com/1.png",
    });
    expect(summary.dislikes.count).toBe(1);
    expect(summary.dislikes.voters).toHaveLength(1);
  });

  it("keeps enough voters to name the ones behind the badge, and no more (#408)", () => {
    const rows: RawVoterRow[] = Array.from({ length: FETCHED_VOTERS + 2 }, (_, i) => ({
      bugId: "bug-1",
      value: 1,
      userId: `u-${i + 1}`,
      name: `User ${i + 1}`,
      image: null,
      total_count: 40,
      rn: i + 1,
    }));

    const summary = buildVoterSummary(rows);
    expect(FETCHED_VOTERS).toBe(13);
    expect(summary.likes.count).toBe(40);
    expect(summary.likes.voters).toHaveLength(FETCHED_VOTERS);
    expect(summary.likes.voters.at(-1)!.name).toBe("User 13");
  });

  it("handles BigInt total_count and rn from PostgreSQL", () => {
    const rows: RawVoterRow[] = [
      {
        bugId: "bug-1",
        value: 1,
        userId: "u-1",
        name: "User One",
        image: null,
        total_count: BigInt(10),
        rn: BigInt(1),
      },
    ];

    const map = buildVoterSummaries(rows, ["bug-1"]);
    const summary = map.get("bug-1")!;
    expect(summary.likes.count).toBe(10);
    expect(summary.likes.voters).toHaveLength(1);
  });
});
