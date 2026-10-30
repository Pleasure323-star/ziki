import { beforeEach, describe, expect, it, vi } from "vitest";

const publish = vi.hoisted(() => vi.fn(async () => ({ id: "event" })));
const isConfirmed = vi.hoisted(() => vi.fn());
const offerNext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-api/events", () => ({ publish }));
vi.mock("@/lib/agent-api/confirmations", () => ({ isConfirmed }));
vi.mock("@/lib/agent-api/offer", () => ({ offerNext }));

import { releaseWorkOfRevokedAgent } from "./revoke-release";

const now = new Date("2026-10-20T12:00:00Z");

function txWith(claims: { id: string; bugId: string; status: "offered" | "active"; beneficiaryUserId: string }[], otherOpen = 0) {
  return {
    $queryRaw: vi.fn(async () => []),
    issueClaim: {
      findMany: vi.fn(async () => claims.map(({ id, bugId }) => ({ id, bugId }))),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => claims.find((c) => c.id === where.id) ?? null),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => otherOpen),
    },
    bug: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => ({ id: "bug-1", projectId: "project-1", title: "Example", status: "open", assigneeId: null })),
    },
    issueBid: { updateMany: vi.fn(async () => ({ count: 2 })) },
    agentAuditEvent: { create: vi.fn(async () => ({})) },
  };
}

const input = { agentId: "agent-dead", tenantId: "tenant-zedu", actorUserId: "ada", now };

describe("revoking an agent hands its work back (#523)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isConfirmed.mockResolvedValue(false);
    offerNext.mockResolvedValue(null);
  });

  it("releases an active claim and reopens the issue", async () => {
    const tx = txWith([{ id: "claim-1", bugId: "bug-1", status: "active", beneficiaryUserId: "ada" }]);

    const result = await releaseWorkOfRevokedAgent(tx as never, input);

    expect(result).toEqual({ releasedClaims: 1, withdrawnBids: 2, offers: [] });
    expect(tx.issueClaim.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { agentId: "agent-dead", releasedAt: null, status: { in: ["offered", "active"] } } }),
    );
    expect(tx.issueClaim.update).toHaveBeenCalledWith({
      where: { id: "claim-1" },
      data: { status: "released", releasedAt: now, releaseReason: "revoked" },
    });
    // Only reopened while it is still this person's in-progress issue, and no fix is linked yet.
    expect(tx.bug.updateMany).toHaveBeenCalledWith({
      where: { id: "bug-1", tenantId: "tenant-zedu", isDeleted: false, assigneeId: "ada", status: "in_progress", pullRequestUrl: null },
      data: { assigneeId: null, status: "open" },
    });
    expect(publish).toHaveBeenCalledWith(tx, expect.objectContaining({
      type: "claim.released",
      bugId: "bug-1",
      payload: expect.objectContaining({ claimId: "claim-1", reason: "revoked" }),
    }));
    expect(tx.agentAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "claim.released", bugId: "bug-1", actorUserId: "ada" }),
    });
  });

  it("releases a pending offer without touching the issue", async () => {
    const tx = txWith([{ id: "claim-2", bugId: "bug-2", status: "offered", beneficiaryUserId: "ada" }]);
    await releaseWorkOfRevokedAgent(tx as never, input);
    expect(tx.issueClaim.update).toHaveBeenCalled();
    expect(tx.bug.updateMany).not.toHaveBeenCalled();
  });

  it("re-offers an open confirmed issue after revoking its active claim", async () => {
    isConfirmed.mockResolvedValue(true);
    offerNext.mockResolvedValue({
      claim: { id: "claim-next" },
      bugTitle: "Example",
      beneficiaryUserId: "bob",
    });
    const tx = txWith([{ id: "claim-1", bugId: "bug-1", status: "active", beneficiaryUserId: "ada" }]);

    const result = await releaseWorkOfRevokedAgent(tx as never, input);

    expect(result.offers).toEqual([{
      id: "claim-next",
      bugId: "bug-1",
      bugTitle: "Example",
      beneficiaryUserId: "bob",
    }]);
    expect(offerNext).toHaveBeenCalledWith(tx, { tenantId: input.tenantId }, expect.objectContaining({
      id: "bug-1",
      status: "open",
    }), ["ada"]);
  });

  it("leaves the issue alone when someone else also holds it", async () => {
    const tx = txWith([{ id: "claim-3", bugId: "bug-3", status: "active", beneficiaryUserId: "ada" }], 1);
    await releaseWorkOfRevokedAgent(tx as never, input);
    expect(tx.bug.updateMany).not.toHaveBeenCalled();
  });

  it("skips a claim that was released while it waited for the lock", async () => {
    const tx = txWith([]);
    tx.issueClaim.findMany.mockResolvedValue([{ id: "claim-gone", bugId: "bug-4" }]);
    const result = await releaseWorkOfRevokedAgent(tx as never, input);
    expect(result.releasedClaims).toBe(0);
    expect(tx.issueClaim.update).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("withdraws only bids that were never awarded", async () => {
    const tx = txWith([]);
    await releaseWorkOfRevokedAgent(tx as never, input);
    expect(tx.issueBid.updateMany).toHaveBeenCalledWith({
      where: { agentId: "agent-dead", withdrawnAt: null, awardedAt: null },
      data: { withdrawnAt: now },
    });
  });

  it("withdraws its open bids, the one way to volunteer (#510, #issue-bids)", async () => {
    const tx = txWith([]);
    const result = await releaseWorkOfRevokedAgent(tx as never, input);
    expect(tx.issueBid.updateMany).toHaveBeenCalledWith({
      where: { agentId: "agent-dead", withdrawnAt: null, awardedAt: null },
      data: { withdrawnAt: now },
    });
    expect(result.withdrawnBids).toBe(2);
  });
});
