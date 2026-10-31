import { describe, expect, it } from "vitest";
import {
  calculateVoteChange,
  isValidVoteDirection,
  MANAGER_VOTE_WEIGHT,
  reconcileVoteCount,
  tallyVoteGroups,
  voteDirection,
} from "./voting";

describe("isValidVoteDirection", () => {
  it("accepts like (1) and dislike (-1)", () => {
    expect(isValidVoteDirection(1)).toBe(true);
    expect(isValidVoteDirection(-1)).toBe(true);
  });

  it("rejects out-of-range or malformed directions", () => {
    for (const bad of [100, -2, 0, 2, 1.5, "1", "-1", null, undefined, NaN]) {
      expect(isValidVoteDirection(bad)).toBe(false);
    }
  });
});

describe("calculateVoteChange", () => {
  it("upvotes from neutral (0 -> +1)", () => {
    expect(calculateVoteChange(0, 1)).toEqual({
      nextVote: 1,
      countDelta: 1,
    });
    expect(calculateVoteChange(null, 1)).toEqual({
      nextVote: 1,
      countDelta: 1,
    });
    expect(calculateVoteChange(undefined, 1)).toEqual({
      nextVote: 1,
      countDelta: 1,
    });
  });

  it("downvotes from neutral (0 -> -1)", () => {
    expect(calculateVoteChange(0, -1)).toEqual({
      nextVote: -1,
      countDelta: -1,
    });
  });

  it("toggles off upvote (+1 -> 0)", () => {
    expect(calculateVoteChange(1, 1)).toEqual({
      nextVote: 0,
      countDelta: -1,
    });
  });

  it("toggles off downvote (-1 -> 0)", () => {
    expect(calculateVoteChange(-1, -1)).toEqual({
      nextVote: 0,
      countDelta: 1,
    });
  });

  it("switches from upvote to downvote (+1 -> -1)", () => {
    expect(calculateVoteChange(1, -1)).toEqual({
      nextVote: -1,
      countDelta: -2,
    });
  });

  it("switches from downvote to upvote (-1 -> +1)", () => {
    expect(calculateVoteChange(-1, 1)).toEqual({
      nextVote: 1,
      countDelta: 2,
    });
  });
});

describe("reconcileVoteCount (#362)", () => {
  it("calculates accurate voteCount from like and dislike counts", () => {
    // #1059: dislikes no longer count; the stored count is the upvotes.
    expect(reconcileVoteCount(5, 2)).toBe(5);
    expect(reconcileVoteCount(0, 3)).toBe(0);
    expect(reconcileVoteCount(4, 4)).toBe(4);
    expect(reconcileVoteCount(0, 0)).toBe(0);
    expect(reconcileVoteCount(100, 0)).toBe(100);
  });
});

describe("manager-weighted upvotes", () => {
  it("reads any positive value as an upvote", () => {
    expect(voteDirection(MANAGER_VOTE_WEIGHT)).toBe(1);
    expect(voteDirection(1)).toBe(1);
    expect(voteDirection(-1)).toBe(-1);
    expect(voteDirection(0)).toBe(0);
    expect(voteDirection(null)).toBe(0);
  });

  it("counts an upvote as its value and a dislike once", () => {
    expect(tallyVoteGroups([
      { value: 1, _count: { _all: 3 } },
      { value: MANAGER_VOTE_WEIGHT, _count: { _all: 2 } },
      { value: -1, _count: { _all: 4 } },
    ])).toEqual({ likeCount: 3 + 2 * MANAGER_VOTE_WEIGHT, dislikeCount: 4 });
  });

  it("toggles a person's manager-weighted upvote off when they click upvote", () => {
    expect(calculateVoteChange(MANAGER_VOTE_WEIGHT, 1)).toMatchObject({ nextVote: 0 });
  });
});
