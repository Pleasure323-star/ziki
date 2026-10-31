import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const mock = {
    issueBid: { findUnique: vi.fn() },
    bidVote: { createMany: vi.fn(), count: vi.fn(), findMany: vi.fn() }, pointEntry: { createMany: vi.fn(async () => ({ count: 1 })) },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  mock.$transaction.mockImplementation((fn: (tx: typeof mock) => unknown) => fn(mock));
  return mock;
});
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/events", () => ({ publish: vi.fn(async () => ({ id: "evt" })) }));
vi.mock("@/lib/agents/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/workflow", () => ({
  workflowFor: vi.fn(async () => ({ governance: "threshold", managerVoteWeight: 3, awardThreshold: 3, offerWindowSeconds: 1800, maxActiveClaims: 2 })),
}));
// One manager's vote, weighted 3: the bid reaches the threshold of 3.
vi.mock("@/lib/agent-api/bid", () => ({ awardInTransaction: vi.fn(), afterAward: vi.fn(), bidTally: vi.fn(async () => 3) }));

import { afterAward, awardInTransaction } from "@/lib/agent-api/bid";
import { atCapacityError } from "@/lib/agent-api/capacity";
import { voteForBid } from "./bid-votes";

const manager = {
  agentId: "dana-agent",
  name: "Dana's Claude",
  ownerId: "dana",
  tenantId: "tenant",
  level: "manager" as const,
  burst: false,
  keyId: "key1",
};

const scope = { id: "bid1", bugId: "issue1", bug: { tenantId: "tenant", projectId: "project", isDeleted: false } };
const openBid = {
  id: "bid1", bugId: "issue1", agentId: "pixel-agent", beneficiaryUserId: "pix", withdrawnAt: null, awardedAt: null,
  agent: { ownerUserId: "pix" },
  bug: { number: 7, status: "open", substatus: "open" },
};

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  db.$queryRaw.mockResolvedValue([{ id: "issue1" }]);
  db.issueBid.findUnique.mockResolvedValueOnce(scope).mockResolvedValueOnce(openBid);
  db.bidVote.createMany.mockResolvedValue({ count: 1 });
  // One manager's vote, weight 3: the bid reaches the award threshold.
  db.bidVote.findMany.mockResolvedValue([{ onBehalfOfUserId: "dana", agent: { level: "manager" } }]);
});

describe("threshold-only auto-award and bidder capacity (#bidder-capacity)", () => {
  it("skips the award of a bid at capacity: the vote stands and awardBlocked is at_capacity", async () => {
    vi.mocked(awardInTransaction).mockRejectedValue(atCapacityError(2, 2));
    const result = await voteForBid(manager, "project", "bid1");
    expect(result).toMatchObject({ bidId: "bid1", votes: 3, threshold: 3, awarded: false, awardBlocked: "at_capacity" });
    expect(db.bidVote.createMany).toHaveBeenCalled();
    expect(afterAward).not.toHaveBeenCalled();
  });

  it("awards as before when the bidder is under capacity", async () => {
    vi.mocked(awardInTransaction).mockResolvedValue({ bidId: "bid1", claimId: "claim1", bugId: "issue1", bugTitle: "x", beneficiaryUserId: "pix" });
    const result = await voteForBid(manager, "project", "bid1");
    expect(result).toMatchObject({ awarded: true, claimId: "claim1" });
    expect(result).not.toHaveProperty("awardBlocked");
  });
});
