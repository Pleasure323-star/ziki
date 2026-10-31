import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(), updateMany: vi.fn(), lock: vi.fn(), publish: vi.fn(), transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  bug: { findMany: mocks.findMany }, $transaction: mocks.transaction,
} }));
vi.mock("@/lib/agent-api/events", () => ({ publish: mocks.publish }));
import { ORPHANED_ISSUE_BATCH, sweepOrphanedIssues } from "./orphaned-issues";

const bug = { id: "orphan", tenantId: "tenant", projectId: "project" };
const guard = {
  isDeleted: false, status: "in_progress", assigneeId: null, pullRequestUrl: null,
  claims: { none: { releasedAt: null, status: { in: ["active", "offered"] } } },
};

describe("orphaned in-progress recovery (#623)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([bug]);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.lock.mockResolvedValue([{ id: bug.id }]);
    mocks.transaction.mockImplementation(async (fn) => fn({
      $queryRaw: mocks.lock, bug: { updateMany: mocks.updateMany },
    }));
    mocks.publish.mockResolvedValue({ id: "event" });
  });

  it("bounds the scan and excludes assigned, deleted, terminal, delivered and claimed issues", async () => {
    await sweepOrphanedIssues();
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: guard, select: { id: true, tenantId: true, projectId: true },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: ORPHANED_ISSUE_BATCH,
    });
  });

  it("reopens an orphan under the issue lock and publishes its system audit event in the transaction", async () => {
    expect(await sweepOrphanedIssues()).toEqual({ reopened: 1 });
    expect(mocks.lock).toHaveBeenCalled();
    expect(mocks.lock.mock.calls[0][0].join("?")).toContain("FOR NO KEY UPDATE");
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.updateMany.mock.invocationCallOrder[0]);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { ...bug, ...guard }, data: { status: "open", substatus: "open" },
    });
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ bug: { updateMany: mocks.updateMany } }), {
      tenantId: "tenant", type: "issue.updated", bugId: "orphan", actorAgentId: null,
      payload: {
        issueId: "orphan", projectId: "project", changed: ["status", "substatus"], values: { status: "open", substatus: "open" },
        actor: { type: "system" }, reason: "orphaned_in_progress", previousStatus: "in_progress",
      },
    });
  });

  // Every guard must be in the conditional UPDATE, not only the initial scan.
  // Simulate a writer winning between scan and lock using the captured predicate.
  it.each([
    ["manual reassignment", { assigneeId: "new-owner" }],
    ["resolution", { status: "resolved", substatus: "on_dev" }],
    ["deletion", { isDeleted: true }],
    ["PR delivery", { pullRequestUrl: "https://github.com/org/repo/pull/1" }],
    ["new active claim", { claim: { status: "active", releasedAt: null } }],
    ["new offered claim", { claim: { status: "offered", releasedAt: null } }],
    ["tenant move", { tenantId: "other" }],
    ["project move", { projectId: "other" }],
  ])("preserves a concurrent %s and emits no recovery event", async (_label, change) => {
    const state = { ...bug, status: "in_progress", substatus: "in_progress", assigneeId: null, isDeleted: false, pullRequestUrl: null, ...change };
    mocks.updateMany.mockImplementation(async ({ where }) => {
      const scalarMatch = Object.entries(where).filter(([key]) => key !== "claims")
        .every(([key, value]) => state[key as keyof typeof state] === value);
      const claim = "claim" in state ? state.claim as { status: string; releasedAt: null } : null;
      const hasLiveClaim = claim && where.claims.none.status.in.includes(claim.status)
        && claim.releasedAt === where.claims.none.releasedAt;
      return { count: scalarMatch && !hasLiveClaim ? 1 : 0 };
    });
    expect(await sweepOrphanedIssues()).toEqual({ reopened: 0 });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("does no transaction work for an empty scan", async () => {
    mocks.findMany.mockResolvedValue([]);
    expect(await sweepOrphanedIssues()).toEqual({ reopened: 0 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("does not count or announce a second sweep that loses the conditional update", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await sweepOrphanedIssues()).toEqual({ reopened: 1 });
    expect(await sweepOrphanedIssues()).toEqual({ reopened: 0 });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it("propagates event failure so the transaction rolls back instead of silently repairing", async () => {
    mocks.publish.mockRejectedValueOnce(new Error("event unavailable"));
    await expect(sweepOrphanedIssues()).rejects.toThrow("event unavailable");
  });
});
