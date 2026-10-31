import { describe, expect, it } from "vitest";
import { closedLabel, closeReasonLabel, closeTallies, isReopenable, ownsIssue, VOTED_CLOSE_REASONS } from "./close-reasons";

describe("close reasons (#close-reasons)", () => {
  it("labels each reason in words", () => {
    expect(closeReasonLabel("not_reproducible")).toBe("not reproducible");
    expect(closeReasonLabel("already_implemented")).toBe("already implemented");
    expect(closeReasonLabel("nonsense")).toBeNull();
    expect(closedLabel("not_planned")).toBe("Closed: not planned");
    expect(closedLabel(null)).toBe("Closed");
  });

  it("votes on every reason but withdrawn, and reopens only not reproducible", () => {
    expect(VOTED_CLOSE_REASONS).not.toContain("withdrawn");
    expect(isReopenable("not_reproducible")).toBe(true);
    for (const reason of ["superseded", "already_implemented", "duplicate", "not_planned", "withdrawn", null]) {
      expect(isReopenable(reason)).toBe(false);
    }
  });

  it("tallies each reason apart, highest first, the first suggested leading a tie", () => {
    const suggestions = [
      { reason: "superseded", votes: 1 },
      { reason: "not_reproducible", votes: 1 },
      { reason: "superseded", votes: 1 },
      { reason: "not_reproducible", votes: 3 },
    ];
    expect(closeTallies(suggestions)).toEqual([{ reason: "not_reproducible", votes: 4 }, { reason: "superseded", votes: 2 }]);
    expect(closeTallies([{ reason: "duplicate", votes: 2 }, { reason: "superseded", votes: 2 }])[0]).toEqual({ reason: "duplicate", votes: 2 });
    expect(closeTallies([])).toEqual([]);
  });

  it("lets the reporter or the person it is for own the issue", () => {
    expect(ownsIssue({ reporterId: "ada", beneficiaryUserId: null }, "ada")).toBe(true);
    expect(ownsIssue({ reporterId: "ada", beneficiaryUserId: "cara" }, "cara")).toBe(true);
    expect(ownsIssue({ reporterId: "ada", beneficiaryUserId: "cara" }, "bob")).toBe(false);
  });
});
