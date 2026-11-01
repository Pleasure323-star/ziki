import { describe, expect, it, vi } from "vitest";

// #pr-reports: whether a pull request was closed without merging is the latest
// agent report on it; Ziki never asks GitHub.
/** Who gets which points (#428, #642): the solver, the dispatcher and reviewers each get the right award, and nobody is paid for work that wasn't merged. */
const reports = vi.hoisted(() => ({
  reportedClosedUnmerged: vi.fn(async (_bugId: string, url?: string | null) => url?.includes("closed") ?? false),
}));
vi.mock("@/lib/agent-api/pull-request-report", () => ({
  reportedClosedUnmerged: reports.reportedClosedUnmerged,
}));

import { awardDispatcher, awardSolver, solverAward } from "@/lib/points/award";
import {
  confirmationReviewerSourceKey,
  CONFIRMATION_REVIEWER_POINTS,
  diminishedReviewerPoints,
  MIN_POINT_AWARD,
  pointSourceKey,
  reviewerPointsAt,
} from "@/lib/points/rules";

/** An in-memory ledger with the unique `sourceKey` the database enforces. */
function fakeLedger() {
  const rows: Array<Record<string, unknown>> = [];
  const createMany = vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
    let count = 0;
    for (const row of data) {
      if (rows.some((r) => r.sourceKey === row.sourceKey)) continue;
      rows.push(row);
      count++;
    }
    return { count };
  });
  return { rows, db: { pointEntry: { createMany } } as never, createMany };
}

const issue = { id: "bug-1", tenantId: "tenant-zedu", assigneeId: "user-1" };

describe("points ledger (#428)", () => {

  it("does not pay a dispatcher for unattributed work", async () => {
    const { db, rows } = fakeLedger();
    expect(await awardDispatcher(db, issue, null)).toBe(false);
    expect(rows).toEqual([]);
  });

  it("builds the flat solver award for the assignee", () => {
    expect(solverAward(issue)).toEqual({
      tenantId: "tenant-zedu",
      userId: "user-1",
      bugId: "bug-1",
      role: "solver",
      points: 750,
      sourceKey: "solver:bug-1:user-1",
    });
  });

  it("awards nobody when the issue has no assignee", async () => {
    const { db, createMany } = fakeLedger();
    expect(solverAward({ ...issue, assigneeId: null })).toBeNull();
    expect(await awardSolver(db, { ...issue, assigneeId: null })).toBe(false);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("pays the same flat amount for every issue, or the project's own amount", async () => {
    const { db, rows } = fakeLedger();
    await awardSolver(db, { ...issue, id: "bug-2" });
    await awardSolver(db, { ...issue, id: "bug-3" });
    await awardSolver(db, {
      ...issue,
      id: "bug-4",
      rewardConfig: { solver: 900, reporter: 150, reviewer: 300, guidelines: null },
    });
    expect(rows.map((r) => r.points)).toEqual([750, 750, 900]);
  });

  it("does not award solver points when the linked pull request is reported closed without being merged (#642)", async () => {
    const { db, rows } = fakeLedger();
    const result = await awardSolver(db, {
      ...issue,
      pullRequestUrl: "https://github.com/zedu/web/pull/closed-1",
    });
    expect(result).toBe(false);
    expect(rows).toEqual([]);
  });
});

describe("point rules (#428)", () => {
  it("pays every later reviewer a little less, and never stops paying", () => {
    expect([0, 1, 2, 3, 4, 5].map((index) => reviewerPointsAt(index, 5))).toEqual([
      5, 4.5, 4.05, 3.65, 3.29, 2.96,
    ]);
    expect(reviewerPointsAt(1, 5)).toBe(diminishedReviewerPoints(5));
    expect([0, 1, 2, 3, 4, 5].map((index) => reviewerPointsAt(index, 10))).toEqual([
      10, 9, 8.1, 7.29, 6.56, 5.9,
    ]);
    expect([0, 1, 2, 3].map((index) => reviewerPointsAt(index, CONFIRMATION_REVIEWER_POINTS))).toEqual([
      90, 81, 72.9, 65.61,
    ]);
    expect(diminishedReviewerPoints(1)).toBe(0.9);
    expect(diminishedReviewerPoints(0.05)).toBe(0.04);
    expect(diminishedReviewerPoints(MIN_POINT_AWARD)).toBe(MIN_POINT_AWARD);

    const tail = Array.from({ length: 80 }, (_, index) => reviewerPointsAt(index, 5));
    for (let index = 1; index < tail.length; index += 1) {
      expect(tail[index]).toBeGreaterThan(0);
      expect(tail[index]).toBeLessThanOrEqual(tail[index - 1]);
    }
    expect(tail[5]).toBeGreaterThan(2);
    expect(tail.at(-1)).toBe(MIN_POINT_AWARD);
    expect(reviewerPointsAt(-1, 5)).toBe(0);
    expect(reviewerPointsAt(0, 0)).toBe(0);
  });

  it("builds one source key per role, issue and person", () => {
    expect(pointSourceKey("solver", "bug-1", "user-1")).toBe("solver:bug-1:user-1");
    expect(pointSourceKey("reporter", "bug-1", "user-1")).toBe("reporter:bug-1:user-1");
    expect(pointSourceKey("reviewer", "bug-1", "user-1")).toBe("reviewer:bug-1:user-1");
    expect(pointSourceKey("solver", "bug-1", "user-2")).not.toBe(pointSourceKey("solver", "bug-1", "user-1"));
    expect(confirmationReviewerSourceKey("bug-1", "user-1")).toBe("reviewer-confirm:bug-1:user-1");
    expect(confirmationReviewerSourceKey("bug-1", "user-1")).not.toBe(pointSourceKey("reviewer", "bug-1", "user-1"));
  });

});
