import { describe, expect, it } from "vitest";
import { stageEntryRoute } from "@/lib/stage-entry-route";

describe("stageEntryRoute", () => {
  const pr = "https://github.com/o/r/pull/1";

  it("follows the status, whatever a linked pull request says (#685)", () => {
    expect(stageEntryRoute({ id: "b", status: "requires_confirmation", pullRequestUrl: pr })?.kind).toBe("confirmation");
    expect(stageEntryRoute({ id: "b", status: "open", pullRequestUrl: pr })?.kind).toBe("bid");
  });

  it("takes the delivery In progress, judgements once Delivered, then merge reviews at Done and Ready to merge", () => {
    expect(stageEntryRoute({ id: "b", status: "in_progress" })).toMatchObject({ kind: "delivery", route: "POST /api/v1/issues/b/delivery" });
    expect(stageEntryRoute({ id: "b", status: "delivered", pullRequestUrl: pr })?.kind).toBe("test_verdict");
    expect(stageEntryRoute({ id: "b", status: "done", pullRequestUrl: pr })?.kind).toBe("merge_review");
    expect(stageEntryRoute({ id: "b", status: "ready_to_merge", pullRequestUrl: pr })?.kind).toBe("merge_review");
    expect(stageEntryRoute({ id: "b", status: "resolved", pullRequestUrl: pr })).toBeNull();
  });
});
