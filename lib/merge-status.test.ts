import { describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock("@/lib/agent-api/events", () => ({ publish: events.publish }));

import { currentDecisionStage } from "@/lib/decision-stages";
import { MERGE_BLOCKED, MERGE_FAILED, REVIEW_STATUSES, mergeOutcomeSummary, recordMergeOutcome } from "./merge-status";

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
  it("says what was blocked and that nothing was merged", () => {
    expect(mergeOutcomeSummary(MERGE_BLOCKED, "The checks are not green.")).toBe(
      "Merge blocked: The checks are not green. Nothing was merged on GitHub.",
    );
    expect(mergeOutcomeSummary(MERGE_FAILED, "GitHub refused the merge.")).toMatch(/^Merge failed: GitHub refused the merge\./);
  });

  it("sets the status, logs it with its reason and what to do, and posts no comment (#review-entries)", async () => {
    const { db, tx } = fakeDb();

    await recordMergeOutcome(db as never, {
      agent: agent as never,
      bug: { id: "bug1", tenantId: "tenant", pullRequestUrl: "https://github.com/o/r/pull/1" },
      status: MERGE_BLOCKED,
      reason: "CodeRabbit has 1 unresolved review thread on this pull request. Resolve them before merging.",
      todo: "The author resolves the thread.",
    });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { reviewStatus: "merge_blocked" } });
    expect(tx.comment.create).not.toHaveBeenCalled();
    expect(tx.bugActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "status_changed",
        actorId: "amo",
        summary: expect.stringMatching(/^Merge blocked: CodeRabbit/),
        metadata: expect.objectContaining({
          reviewStatus: "merge_blocked",
          reason: expect.stringMatching(/^CodeRabbit/),
          todo: "The author resolves the thread.",
          note: "What to do: The author resolves the thread.",
        }),
      }),
    });
    expect(events.publish).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ type: "issue.updated", payload: expect.objectContaining({ reviewStatus: "merge_blocked", todo: "The author resolves the thread." }) }),
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
