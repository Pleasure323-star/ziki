import { describe, expect, it } from "vitest";
import { ideaVotes, isAutoRejectable, isBadIdea, notRejectableReason } from "./idea-rejection";

describe("idea rejection rule (#idea-rejected)", () => {
  it("adds up the verdicts' votes, and the good ones", () => {
    expect(ideaVotes([
      { opinion: "good", votes: 1 },
      { opinion: "bad", votes: 5 },
      { opinion: "neutral", votes: 1 },
      { opinion: "good", votes: 2 },
    ])).toEqual({ total: 9, good: 3, people: 4 });
    expect(ideaVotes([])).toEqual({ total: 0, good: 0, people: 0 });
  });

  it("calls 1 good, 1 neutral and 1 bad vote at threshold 3 a bad idea", () => {
    const votes = ideaVotes([
      { opinion: "good", votes: 1 },
      { opinion: "neutral", votes: 1 },
      { opinion: "bad", votes: 1 },
    ]);
    expect(votes).toEqual({ total: 3, good: 1, people: 3 });
    expect(isBadIdea(votes, 3)).toBe(true);
  });

  it.each([
    [{ total: 3, good: 1 }, 3, true],
    [{ total: 6, good: 2 }, 3, true],
    [{ total: 6, good: 0 }, 5, true],
    [{ total: 2, good: 0 }, 3, false],
    [{ total: 4, good: 2 }, 3, false],
    [{ total: 6, good: 3 }, 3, false],
    [{ total: 5, good: 0 }, 6, false],
  ])("votes %o at threshold %s: bad is %s", (votes, threshold, expected) => {
    expect(isBadIdea(votes, threshold)).toBe(expected);
  });

  it("says why an idea can't be rejected yet", () => {
    expect(notRejectableReason({ total: 1, good: 0 }, 3)).toBe("This idea has 1 vote; it can be rejected once it has 3.");
    expect(notRejectableReason({ total: 2, good: 0 }, 3)).toBe("This idea has 2 votes; it can be rejected once it has 3.");
    expect(notRejectableReason({ total: 4, good: 2 }, 3)).toBe("This idea has 2 good votes of 4; it can be rejected only when its bad and neutral votes outnumber its good ones.");
    expect(notRejectableReason({ total: 3, good: 1 }, 1)).toBe("This idea has 1 good vote of 3; it can be rejected only when its bad and neutral votes outnumber its good ones.");
  });
});

describe("automatic rejection needs two people (#vote-governance)", () => {
  it("does not reject on one person's verdict, even a manager's weight of 3 at threshold 3", () => {
    const one = ideaVotes([{ opinion: "bad", votes: 3 }]);
    expect(isBadIdea(one, 3)).toBe(true);
    expect(isAutoRejectable(one, 3)).toBe(false);
    expect(isAutoRejectable(ideaVotes([{ opinion: "neutral", votes: 3 }]), 3)).toBe(false);
  });

  it("rejects a bad idea once two different people gave verdicts", () => {
    expect(isAutoRejectable(ideaVotes([{ opinion: "bad", votes: 3 }, { opinion: "neutral", votes: 1 }]), 3)).toBe(true);
    expect(isAutoRejectable({ total: 3, good: 1, people: 2 }, 3)).toBe(true);
  });

  it("still needs the idea to be bad", () => {
    expect(isAutoRejectable(ideaVotes([{ opinion: "good", votes: 3 }, { opinion: "bad", votes: 1 }]), 3)).toBe(false);
    // A tally that does not say how many people judged it is not enough.
    expect(isAutoRejectable({ total: 3, good: 0 }, 3)).toBe(false);
  });
});
