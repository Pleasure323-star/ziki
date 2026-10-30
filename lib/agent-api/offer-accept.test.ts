import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  issueClaim: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), count: vi.fn() },
  issueBid: { findFirst: vi.fn(), updateMany: vi.fn() },
  bug: { update: vi.fn() },
  bugActivity: { createMany: vi.fn() },
}));
const publish = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/events", () => ({ publish }));
vi.mock("@/lib/watch", () => ({ ensureWatching: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-notifications", () => ({ notifyClaimOffered: vi.fn() }));
vi.mock("@/lib/workflow", async (original) => {
  const { DEFAULT_PROJECT_WORKFLOW } = await import("@/lib/workflow-config");
  return { ...await original<typeof import("@/lib/workflow")>(), workflowFor: vi.fn(async () => ({ ...DEFAULT_PROJECT_WORKFLOW })) };
});

import { acceptOffer } from "./offer";
import type { AgentContext } from "@/lib/agents/require-agent";

const agent = { agentId: "agent-1", name: "Ada's Claude", ownerId: "ada", tenantId: "t1", level: "working", burst: false, keyId: "k1" } as AgentContext;

const offered = {
  id: "claim-1",
  bugId: "bug-1",
  agentId: "agent-1",
  beneficiaryUserId: "ada",
  status: "offered",
  offeredAt: new Date(),
  releasedAt: null,
  releaseReason: null,
  beneficiary: { name: "Ada" },
  bug: { id: "bug-1", title: "Bug 1", status: "open", assigneeId: null, tenantId: "t1", projectId: "p1", areaId: null, voteCount: 0, assignee: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((run: (tx: unknown) => unknown) => run(db));
  db.$queryRaw.mockResolvedValue([{ id: "bug-1" }]);
  db.issueClaim.findUnique.mockResolvedValue({ ...offered, offeredAt: new Date() });
  db.issueClaim.findFirst.mockResolvedValue(null);
  db.issueClaim.count.mockResolvedValue(0);
  db.bug.update.mockResolvedValue({ id: "bug-1", assigneeId: "ada", status: "in_progress" });
  db.issueBid.updateMany.mockResolvedValue({ count: 2 });
});

describe("acceptOffer and bids (#award-bids)", () => {
  it("withdraws the other open bids when the accepted claim came from a bid award", async () => {
    db.issueBid.findFirst.mockResolvedValue({ id: "bid-1" });
    const result = await acceptOffer(agent, "claim-1");
    expect(result).toMatchObject({ expired: false, claim: { id: "claim-1", status: "active" } });
    expect(db.issueBid.findFirst).toHaveBeenCalledWith({ where: { claimId: "claim-1" }, select: { id: true } });
    expect(db.issueBid.updateMany).toHaveBeenCalledWith({
      where: { bugId: "bug-1", withdrawnAt: null, awardedAt: null },
      data: { withdrawnAt: expect.any(Date) },
    });
    expect(db.bug.update).toHaveBeenCalledWith(expect.objectContaining({ data: { assigneeId: "ada", status: "in_progress" } }));
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "claim.accepted" }));
  });

  it("leaves bids alone when the accepted offer did not come from a bid", async () => {
    db.issueBid.findFirst.mockResolvedValue(null);
    await acceptOffer(agent, "claim-1");
    expect(db.issueBid.updateMany).not.toHaveBeenCalled();
  });
});
