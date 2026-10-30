import { describe, expect, it } from "vitest";
import { canRejectIdea, ideaVotes, notRejectableReason } from "./idea-rejection";

describe("idea rejection rule (#idea-rejected)", () => {
  it("adds up the verdicts' votes, and the good ones", () => {
    expect(ideaVotes([
      { opinion: "good", votes: 1 },
      { opinion: "bad", votes: 5 },
      { opinion: "neutral", votes: 1 },
      { opinion: "good", votes: 2 },
    ])).toEqual({ total: 9, good: 3 });
    expect(ideaVotes([])).toEqual({ total: 0, good: 0 });
  });

  it.each([
    [{ total: 6, good: 2 }, true],
    [{ total: 6, good: 0 }, true],
    [{ total: 5, good: 0 }, false],
    [{ total: 6, good: 3 }, false],
    [{ total: 20, good: 3 }, false],
  ])("more than 5 votes and fewer than 3 good: %o → %s", (votes, expected) => {
    expect(canRejectIdea(votes)).toBe(expected);
  });

  it("says why an idea can't be rejected yet", () => {
    expect(notRejectableReason({ total: 1, good: 0 })).toBe("This idea has 1 vote; it can be rejected once it has more than 5.");
    expect(notRejectableReason({ total: 5, good: 0 })).toBe("This idea has 5 votes; it can be rejected once it has more than 5.");
    expect(notRejectableReason({ total: 8, good: 3 })).toBe("This idea has 3 good votes; only an idea with fewer than 3 can be rejected.");
  });
});
