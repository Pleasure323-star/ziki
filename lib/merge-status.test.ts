import { describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock("@/lib/agent-api/events", () => ({ publish: events.publish }));

import { currentDecisionStage } from "@/lib/decision-stages";
import { MERGE_BLOCKED, MERGE_FAILED, REVIEW_STATUSES, mergeOutcomeComment, recordMergeOutcome } from "./merge-status";

const agent = { agentId: "am1", name: "Admin merger", ownerId: "amo", tenantId: "tenant", level: "merger", burst: false, keyId: "k" };

function fakeDb() {
  const tx = {
    bug: { update: vi.fn() },
    comment: { create: vi.fn(async () => ({ id: "c1" })) },
    bugActivity: { create: vi.fn() },
  };
  const db = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { db, tx };
}

describe("merge statuses", () => {
  it("says what was blocked and that nothing was merged, resolved or paid", () => {
    expect(mergeOutcomeComment(MERGE_BLOCKED, "The checks are not green.")).toBe(
      "Merge blocked: The checks are not green. Nothing was merged on GitHub, the issue was not resolved, and no points were paid.",
    );
    expect(mergeOutcomeComment(MERGE_FAILED, "GitHub refused the merge.")).toMatch(/^Merge failed: GitHub refused the merge\./);
  });

  it("sets the status and posts the comment together", async () => {
    const { db, tx } = fakeDb();

    await recordMergeOutcome(db as never, {
      agent: agent as never,
      bug: { id: "bug1", tenantId: "tenant", pullRequestUrl: "https://github.com/o/r/pull/1" },
      status: MERGE_BLOCKED,
      reason: "CodeRabbit has 1 unresolved review thread on this pull request. Resolve them before merging.",
    });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { reviewStatus: "merge_blocked" } });
    expect(tx.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ agentId: "am1", body: expect.stringMatching(/^Merge blocked: CodeRabbit/) }) }),
    );
    expect(events.publish).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ type: "issue.updated", payload: expect.objectContaining({ reviewStatus: "merge_blocked" }) }),
    );
  });

  it("lists every review status the issue filter accepts", () => {
    expect(REVIEW_STATUSES).toEqual(["submitted", "tested", "ready_to_merge", "rejected", "merge_blocked", "merge_failed", "merged"]);
  });

  it("keeps a blocked or failed merge at the Ready to merge stage", () => {
    const issue = { status: "in_progress", pullRequestUrl: "https://github.com/o/r/pull/1", hasClaim: true, converted: true, ideaAccepted: true };
    expect(currentDecisionStage({ ...issue, reviewStatus: MERGE_BLOCKED })).toBe("ready");
    expect(currentDecisionStage({ ...issue, reviewStatus: MERGE_FAILED })).toBe("ready");
    expect(currentDecisionStage({ ...issue, reviewStatus: "merged" })).toBe("live");
  });
});
