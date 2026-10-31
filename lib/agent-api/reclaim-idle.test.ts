import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/agents/require-agent";

const db = vi.hoisted(() => ({
  bug: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  bugActivity: { create: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
const mocks = vi.hoisted(() => ({
  staleHold: vi.fn(),
  idleInProgress: vi.fn(),
  strandedDelivery: vi.fn(),
  publish: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth-helpers", () => ({ requireSuperAdmin: vi.fn() }));
vi.mock("@/lib/agent-notifications", () => ({ notifyAgentQuestion: vi.fn() }));
vi.mock("@/lib/agent-api/offer", () => ({ expireOffer: vi.fn() }));
vi.mock("@/lib/agent-api/stale-hold", () => ({ staleHold: mocks.staleHold }));
vi.mock("@/lib/agent-api/idle", () => ({ idleInProgress: mocks.idleInProgress }));
vi.mock("@/lib/agent-api/stranded-delivery", () => ({ strandedDelivery: mocks.strandedDelivery }));
vi.mock("@/lib/agent-api/events", () => ({ publish: mocks.publish }));
vi.mock("@/lib/agents/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/workflow", () => ({ workflowFor: vi.fn(async () => ({ heartbeatMinutes: 240 })) }));
vi.mock("@/lib/issue-ref", () => ({
  parseIssueRef: vi.fn((ref: string) => ref),
  resolveIssueRef: vi.fn(async () => ({ id: "b8" })),
  issueIdFor: vi.fn(async () => "b8"),
}));

import { reclaimStaleIssue } from "./availability";

const manager = (ownerId = "owner-dana", level: AgentContext["level"] = "manager"): AgentContext => ({
  agentId: `agent-${ownerId}`,
  name: "Manager",
  ownerId,
  tenantId: "t1",
  level,
  burst: false,
  keyId: "k1",
  projectId: "p1",
});

const lastUpdate = new Date("2026-10-31T06:00:00Z");
const idleWork = (claim: { id: string } | null = null) => ({ bug: { id: "b8", projectId: "p1", updatedAt: lastUpdate }, claim, lastUpdate, windowMinutes: 120 });
const reviewed = {
  reporterId: "owner-ada",
  beneficiaryUserId: "owner-ada",
  assigneeId: "owner-cara",
  createdByAgent: { ownerUserId: "owner-ada" },
  claims: [{ status: "released", releasedAt: lastUpdate, beneficiaryUserId: "owner-cara", dispatcherUserId: null, agent: { ownerUserId: "owner-cara" } }],
};

beforeEach(() => {
  vi.resetAllMocks();
  db.bug.findFirst.mockResolvedValue({ id: "b8", number: 8, tenantId: "t1", projectId: "p1" });
  db.bug.findUnique.mockImplementation(async (args: { select: Record<string, unknown> }) => ("reporterId" in args.select ? reviewed : { assigneeId: "owner-cara", status: "open", substatus: "open" }));
  db.bug.updateMany.mockResolvedValue({ count: 1 });
  db.$queryRaw.mockResolvedValue([{ id: "b8" }]);
  db.$transaction.mockImplementation((run: (tx: typeof db) => unknown) => run(db));
  mocks.staleHold.mockResolvedValue(null);
  mocks.idleInProgress.mockResolvedValue(idleWork());
  mocks.strandedDelivery.mockResolvedValue(null);
});

describe("reclaiming idle In progress work nobody holds (#idle)", () => {
  it("lets an independent manager send it back to Open with no assignee", async () => {
    await expect(reclaimStaleIssue(manager(), "p1", "b8")).resolves.toEqual({ issueId: "b8", issueNumber: 8, claimId: null, reason: "idle", status: "open", substatus: "open" });
    expect(db.bug.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "b8", status: "in_progress", isDeleted: false }),
      data: { status: "open", substatus: "open", assigneeId: null },
    });
    expect(db.bugActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ bugId: "b8", type: "status_changed", metadata: expect.objectContaining({ from: "in_progress", to: "open", via: "idle" }) }),
    });
    expect(mocks.publish).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "issue.updated",
      bugId: "b8",
      payload: expect.objectContaining({ reason: "idle", previousAssigneeId: "owner-cara" }),
    }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-owner-dana" }), "issue.updated", "issue:b8", expect.objectContaining({ reason: "idle" }), { bugId: "b8" });
  });

  it("refuses when the issue is not idle", async () => {
    mocks.idleInProgress.mockResolvedValue(null);
    await expect(reclaimStaleIssue(manager(), "p1", "b8")).rejects.toMatchObject({ status: 409, body: expect.objectContaining({ error: "not_stale" }) });
    expect(db.bug.updateMany).not.toHaveBeenCalled();
  });

  it("refuses when someone holds it: that is a sense check, not a reclaim", async () => {
    mocks.idleInProgress.mockResolvedValue(idleWork({ id: "c1" }));
    await expect(reclaimStaleIssue(manager(), "p1", "b8")).rejects.toMatchObject({ status: 409, body: expect.objectContaining({ error: "not_stale" }) });
    expect(db.bug.updateMany).not.toHaveBeenCalled();
  });

  it("refuses when it became held or updated after the first check", async () => {
    mocks.idleInProgress.mockResolvedValueOnce(idleWork()).mockResolvedValueOnce(null);
    await expect(reclaimStaleIssue(manager(), "p1", "b8")).rejects.toMatchObject({ status: 409 });
    expect(db.bug.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a working agent", async () => {
    await expect(reclaimStaleIssue(manager("owner-eli", "working"), "p1", "b8")).rejects.toThrow();
    expect(db.bug.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a manager whose owner is assigned to it or filed it", async () => {
    for (const ownerId of ["owner-cara", "owner-ada"]) {
      await expect(reclaimStaleIssue(manager(ownerId), "p1", "b8")).rejects.toMatchObject({ status: 403, body: expect.objectContaining({ error: "not_independent" }) });
    }
    expect(db.bug.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a stranded delivery, which is delivered instead", async () => {
    mocks.strandedDelivery.mockResolvedValue({ pullRequestUrl: "https://github.com/emerjent/ziki/pull/9" });
    await expect(reclaimStaleIssue(manager(), "p1", "b8")).rejects.toMatchObject({ status: 409, body: expect.objectContaining({ error: "stranded_delivery" }) });
    expect(db.bug.updateMany).not.toHaveBeenCalled();
  });
});
