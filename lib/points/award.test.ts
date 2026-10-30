import { describe, expect, it, vi } from "vitest";

const mergePr = vi.hoisted(() => ({
  isPullRequestClosedUnmerged: vi.fn(async (url?: string | null) => url?.includes("closed") ?? false),
}));
vi.mock("@/lib/github/merge-pr", () => ({
  isPullRequestClosedUnmerged: mergePr.isPullRequestClosedUnmerged,
}));

import { award, awardDispatcher, awardSolver, solverAward } from "./award";

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
  it("pays the dispatcher once per completed issue, including reassignment", async () => {
    const { db, rows } = fakeLedger();
    expect(await awardDispatcher(db, { id: "bug-1", tenantId: "tenant-zedu" }, "dispatcher-owner")).toBe(true);
    expect(await awardDispatcher(db, { id: "bug-1", tenantId: "tenant-zedu" }, "dispatcher-owner")).toBe(false);
    expect(await awardDispatcher(db, { id: "bug-1", tenantId: "tenant-zedu" }, "another-owner")).toBe(false);
    expect(rows).toEqual([{
      tenantId: "tenant-zedu", bugId: "bug-1", userId: "dispatcher-owner",
      role: "dispatcher", points: 60, sourceKey: "dispatcher:bug-1",
    }]);
  });

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

  it("awards solver points once, even when resolved again", async () => {
    const { db, rows } = fakeLedger();
    expect(await awardSolver(db, issue)).toBe(true);
    expect(await awardSolver(db, issue)).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ points: 750, role: "solver" });
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

  it("skips duplicates in the database instead of failing", async () => {
    const { db, createMany } = fakeLedger();
    await award(db, { tenantId: "t", userId: "u", bugId: null, role: "reporter", points: 5, sourceKey: "reporter:b:u" });
    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
  });

  it("does not award solver points when the linked pull request is closed without being merged (#642)", async () => {
    const { db, rows } = fakeLedger();
    const result = await awardSolver(db, {
      ...issue,
      pullRequestUrl: "https://github.com/zedu/web/pull/closed-1",
    });
    expect(result).toBe(false);
    expect(rows).toEqual([]);
  });
});
