import { describe, expect, it, vi } from "vitest";
import { ideaVoteTotals } from "./idea-vote-totals";

describe("ideaVoteTotals (#724)", () => {
  it("adds up each idea's weighted votes by opinion, and gives zeros to an idea nobody judged", async () => {
    const groupBy = vi.fn(async () => [
      { ideaId: "i1", opinion: "good", _sum: { votes: 4 } },
      { ideaId: "i1", opinion: "bad", _sum: { votes: 1 } },
      { ideaId: "i1", opinion: "neutral", _sum: { votes: 2 } },
    ]);
    const totals = await ideaVoteTotals({ ideaVerdict: { groupBy } } as never, ["i1", "i2"]);
    expect(totals.get("i1")).toEqual({ good: 4, bad: 1, neutral: 2 });
    expect(totals.get("i2")).toEqual({ good: 0, bad: 0, neutral: 0 });
  });
});
