import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const mock = {
    issueBid: { findUnique: vi.fn() },
    bidVote: { createMany: vi.fn(), count: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  mock.$transaction.mockImplementation((fn: (tx: typeof mock) => unknown) => fn(mock));
  return mock;
});
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/events", () => ({ publish: vi.fn(async () => ({ id: "evt" })) }));
vi.mock("@/lib/agents/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { publish } from "@/lib/agent-api/events";
import { audit } from "@/lib/agents/audit";
import { voteForBid } from "./bid-votes";

const eli = {
  agentId: "eli-agent",
  name: "Eli's Claude",
  ownerId: "eli",
  tenantId: "tenant",
  level: "working" as const,
  burst: false,
  keyId: "key1",
};

const scope = { id: "bid1", bugId: "issue1", bug: { tenantId: "tenant", projectId: "project", isDeleted: false } };
const openBid = {
  id: "bid1", bugId: "issue1", agentId: "bob-agent", beneficiaryUserId: "bob", withdrawnAt: null, awardedAt: null,
  agent: { ownerUserId: "bob" },
  bug: { number: 7, status: "open" },
};

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  db.$queryRaw.mockResolvedValue([{ id: "issue1" }]);
  db.issueBid.findUnique.mockResolvedValueOnce(scope).mockResolvedValueOnce(openBid);
  db.bidVote.createMany.mockResolvedValue({ count: 1 });
  db.bidVote.count.mockResolvedValue(1);
});

describe("voteForBid (#bid-votes)", () => {
  it("records one vote for the voter's owner, publishes issue.bid_voted and audits it", async () => {
    await expect(voteForBid(eli, "project", "bid1")).resolves.toEqual({ bidId: "bid1", votes: 1 });
    expect(db.bidVote.createMany).toHaveBeenCalledWith({
      data: [{ bidId: "bid1", bugId: "issue1", onBehalfOfUserId: "eli", agentId: "eli-agent" }],
      skipDuplicates: true,
    });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "issue.bid_voted",
      actorAgentId: "eli-agent",
      payload: expect.objectContaining({ bidId: "bid1", issueId: "issue1", issueNumber: 7, bidAgentId: "bob-agent", votes: 1 }),
    }));
    expect(audit).toHaveBeenCalledWith(eli, "issue.bid_voted", "issue:issue1", { bidId: "bid1", votes: 1 }, { bugId: "issue1" });
  });

  it("is idempotent: voting again counts once and publishes nothing new", async () => {
    db.bidVote.createMany.mockResolvedValue({ count: 0 });
    db.bidVote.count.mockResolvedValue(2);
    await expect(voteForBid(eli, "project", "bid1")).resolves.toEqual({ bidId: "bid1", votes: 2 });
    expect(publish).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses the owner's own bid with 403 own_bid, as beneficiary or as the bidding agent's owner", async () => {
    for (const bid of [{ ...openBid, beneficiaryUserId: "eli" }, { ...openBid, agent: { ownerUserId: "eli" } }]) {
      db.issueBid.findUnique.mockReset();
      db.issueBid.findUnique.mockResolvedValueOnce(scope).mockResolvedValueOnce(bid);
      await expect(voteForBid(eli, "project", "bid1")).rejects.toMatchObject({
        status: 403,
        body: expect.objectContaining({ error: "own_bid" }),
      });
    }
    expect(db.bidVote.createMany).not.toHaveBeenCalled();
  });

  it("refuses a withdrawn or awarded bid, and a bid on an issue that is not open, with 409", async () => {
    for (const bid of [{ ...openBid, withdrawnAt: new Date() }, { ...openBid, awardedAt: new Date() }, { ...openBid, bug: { number: 7, status: "in_progress" } }]) {
      db.issueBid.findUnique.mockReset();
      db.issueBid.findUnique.mockResolvedValueOnce(scope).mockResolvedValueOnce(bid);
      await expect(voteForBid(eli, "project", "bid1")).rejects.toMatchObject({ status: 409 });
    }
    expect(db.bidVote.createMany).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown bid, another tenant's, another project's or a deleted issue's", async () => {
    for (const found of [null, { ...scope, bug: { ...scope.bug, tenantId: "other" } }, { ...scope, bug: { ...scope.bug, projectId: "other" } }, { ...scope, bug: { ...scope.bug, isDeleted: true } }]) {
      db.issueBid.findUnique.mockReset();
      db.issueBid.findUnique.mockResolvedValueOnce(found);
      await expect(voteForBid(eli, "project", "bid1")).rejects.toMatchObject({ status: 404 });
    }
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a key restricted to another project", async () => {
    await expect(voteForBid({ ...eli, projectId: "key-project" }, "project", "bid1")).rejects.toThrow("restricted");
    expect(db.issueBid.findUnique).not.toHaveBeenCalled();
  });
});
