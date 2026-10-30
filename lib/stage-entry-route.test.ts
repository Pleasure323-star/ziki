import { describe, expect, it } from "vitest";
import { stageEntryRoute } from "@/lib/stage-entry-route";

describe("stageEntryRoute", () => {
  const pr = "https://github.com/o/r/pull/1";

  it("follows the status, whatever a linked pull request or review says (#685)", () => {
    expect(stageEntryRoute({ id: "b", status: "requires_confirmation", pullRequestUrl: pr, reviewStatus: "submitted" })?.kind).toBe(
      "confirmation",
    );
    expect(stageEntryRoute({ id: "b", status: "open", pullRequestUrl: pr, reviewStatus: "ready_to_merge" })?.kind).toBe("bid");
  });

  it("takes test verdicts and merge reviews only while the issue is in progress", () => {
    expect(stageEntryRoute({ id: "b", status: "in_progress" })).toBeNull();
    expect(stageEntryRoute({ id: "b", status: "in_progress", pullRequestUrl: pr })?.kind).toBe("test_verdict");
    expect(stageEntryRoute({ id: "b", status: "in_progress", reviewStatus: "ready_to_merge" })?.kind).toBe("merge_review");
    expect(stageEntryRoute({ id: "b", status: "resolved", reviewStatus: "merged" })).toBeNull();
  });
});
