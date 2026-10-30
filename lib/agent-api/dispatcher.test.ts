import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLevelError } from "@/lib/agents/levels";

const db = vi.hoisted(() => ({
  bug: { findMany: vi.fn(), update: vi.fn(), count: vi.fn() },
  issueBid: { findMany: vi.fn(), count: vi.fn() },
  issueClaim: { update: vi.fn(), count: vi.fn() },
}));
const isConfirmed = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/confirmations", () => ({ isConfirmed }));

import { findReadyIssues, getDispatcherMetrics } from "./dispatcher";

const dispatcher = {
  agentId: "agent-disp",
  name: "Dispatcher",
  ownerId: "owner",
  tenantId: "tenant",
  level: "manager" as const,
  burst: false,
  keyId: "key-disp",
};

const contributor = { ...dispatcher, level: "working" as const };

const readyBug = {
  id: "bug-1",
  number: 1,
  title: "Ready",
  projectId: "project-1",
  areaId: null,
  voteCount: 4,
  assigneeId: null,
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  db.bug.findMany.mockResolvedValue([readyBug]);
  db.issueBid.findMany.mockResolvedValue([]);
  isConfirmed.mockResolvedValue(true);
});

describe("findReadyIssues", () => {
  it("lets a merger agent dispatch, since it can do everything a manager can", async () => {
    const merger = { ...dispatcher, level: "merger" as const };
    db.bug.findMany.mockResolvedValue([]);
    await expect(findReadyIssues(merger, "project-1")).resolves.toEqual([]);
  });
  it("requires a manager agent", async () => {
    await expect(findReadyIssues(contributor, "project-1")).rejects.toBeInstanceOf(AgentLevelError);
  });

  it("applies the limit after confirmation so older unconfirmed issues cannot starve dispatch", async () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({ ...readyBug, id: `bug-${index}` }));
    db.bug.findMany.mockImplementation(async (args) => {
      const start = args.cursor ? rows.findIndex((row) => row.id === args.cursor.id) + args.skip : 0;
      return rows.slice(start, start + args.take);
    });
    isConfirmed.mockImplementation(async (id) => id === "bug-59");

    expect(await findReadyIssues(dispatcher, "project-1", 10)).toEqual([
      { ...rows[59], confirmed: true },
    ]);
  });

  it("bounds confirmation concurrency and stops after enough ready issues", async () => {
    db.bug.findMany.mockResolvedValue(Array.from({ length: 50 }, (_, index) => ({ ...readyBug, id: `bug-${index}` })));
    let active = 0;
    let peak = 0;
    isConfirmed.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return true;
    });

    expect(await findReadyIssues(dispatcher, "project-1", 1)).toHaveLength(1);
    expect(peak).toBeLessThanOrEqual(10);
    expect(isConfirmed).toHaveBeenCalledTimes(10);
    expect(db.bug.findMany).toHaveBeenCalledOnce();
  });

  it("still limits the number of confirmed issues returned", async () => {
    db.bug.findMany.mockResolvedValue([readyBug, { ...readyBug, id: "bug-2" }]);

    expect(await findReadyIssues(dispatcher, "project-1", 1)).toEqual([
      { ...readyBug, confirmed: true },
    ]);
  });

  it("uses confirmed readiness for metrics without the list page limit", async () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({ ...readyBug, id: `bug-${index}` }));
    db.bug.findMany.mockImplementation(async (args) => {
      const start = args.cursor ? rows.findIndex((row) => row.id === args.cursor.id) + args.skip : 0;
      return rows.slice(start, start + args.take);
    });
    db.bug.count.mockResolvedValue(60);
    db.issueClaim.count.mockResolvedValue(0);
    db.issueBid.count.mockResolvedValue(0);
    isConfirmed.mockImplementation(async (id) => id !== "bug-0");

    expect(await getDispatcherMetrics(dispatcher, "project-1")).toEqual({
      readyIssues: 59, activeClaims: 0, pendingOffers: 0, openBids: 0,
    });
    expect(db.bug.findMany).toHaveBeenCalledTimes(2);
    expect(db.bug.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      take: 50, cursor: { id: "bug-49" }, skip: 1,
    }));
  });

  it("clamps non-finite limits to MAX_READY_ISSUES_LIMIT (#637)", async () => {
    db.bug.findMany.mockResolvedValueOnce([]);
    await findReadyIssues(dispatcher, "project-1", Number.POSITIVE_INFINITY);
    expect(db.bug.findMany).toHaveBeenCalledTimes(1);
  });

  it("returns only confirmed issues at the upvote threshold", async () => {
    isConfirmed.mockResolvedValueOnce(false);
    expect(await findReadyIssues(dispatcher, "project-1")).toEqual([]);
  });

  it("includes issues whose pending offers have expired", async () => {
    expect(await findReadyIssues(dispatcher, "project-1")).toEqual([{ ...readyBug, confirmed: true }]);
    expect(db.bug.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          claims: {
            none: expect.objectContaining({
              releasedAt: null,
              OR: expect.arrayContaining([
                { status: "active" },
                expect.objectContaining({ status: "offered" }),
              ]),
            }),
          },
        }),
      })
    );
  });
});
