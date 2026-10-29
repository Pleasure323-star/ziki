import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBugFindMany = vi.hoisted(() => vi.fn());
const mockBugActivityCreate = vi.hoisted(() => vi.fn());
const mockCommentFindMany = vi.hoisted(() => vi.fn());
const mockCommentCreate = vi.hoisted(() => vi.fn());
const mockCommentUpdate = vi.hoisted(() => vi.fn());
const mockIssueBidFindMany = vi.hoisted(() => vi.fn());
const mockIssueClaimCount = vi.hoisted(() => vi.fn());
const mockAwardBid = vi.hoisted(() => vi.fn());
const mockIsConfirmed = vi.hoisted(() => vi.fn());
const mockPublish = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bug: { findMany: mockBugFindMany },
    bugActivity: { create: mockBugActivityCreate },
    comment: {
      findMany: mockCommentFindMany,
      create: mockCommentCreate,
      update: mockCommentUpdate,
    },
    issueBid: {
      findMany: mockIssueBidFindMany,
    },
    issueClaim: { count: mockIssueClaimCount },
  },
}));

vi.mock("@/lib/agent-api/bid", () => ({ awardBid: mockAwardBid }));
vi.mock("@/lib/agent-api/confirmations", () => ({ isConfirmed: mockIsConfirmed }));
// Readiness comes from one bulk read (#714); these issues are all confirmed.
const mockConfirmedIssueIds = vi.hoisted(() => vi.fn(async () => new Set(["bug-1", "bug-2", "bug-3"])));
vi.mock("@/lib/issue-stage", () => ({ confirmedIssueIds: mockConfirmedIssueIds }));
vi.mock("@/lib/workflow", () => ({ workflowFor: vi.fn(async () => ({ offerWindowSeconds: 1800 })) }));
vi.mock("@/lib/agent-api/events", () => ({ publish: mockPublish }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sweepPendingBids } from "./bids";

describe("sweepPendingBids - Direct Fair Bid Auto-Assignment", () => {
  const mockNow = new Date("2026-10-27T12:00:00.000Z");

  const sampleIssue = {
    id: "bug-1",
    title: "Fix latency bug",
    number: 101,
    tenantId: "tenant-zedu",
    projectId: "proj-web",
    reporterId: "user-reporter",
    severity: "high",
    voteCount: 5,
    claims: [] as { offeredAt: Date | null }[],
  };

  const sampleBidA = {
    id: "bid-a",
    bugId: "bug-1",
    agentId: "agent-a",
    beneficiaryUserId: "user-a",
    createdAt: new Date("2026-10-27T10:00:00.000Z"),
    agent: {
      id: "agent-a",
      name: "AlphaAgent",
      ownerUserId: "user-a",
      revokedAt: null,
    },
    beneficiary: {
      id: "user-a",
      name: "Alice",
    },
  };

  const sampleBidB = {
    id: "bid-b",
    bugId: "bug-1",
    agentId: "agent-b",
    beneficiaryUserId: "user-b",
    createdAt: new Date("2026-10-27T10:05:00.000Z"),
    agent: {
      id: "agent-b",
      name: "BetaAgent",
      ownerUserId: "user-b",
      revokedAt: null,
    },
    beneficiary: {
      id: "user-b",
      name: "Bob",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConfirmed.mockResolvedValue(true);
    mockBugActivityCreate.mockResolvedValue({ id: "activity-1" });
    mockCommentCreate.mockImplementation(async ({ data }) => ({
      id: "comment-new",
      ...data,
      createdAt: mockNow,
    }));
    mockCommentUpdate.mockResolvedValue({ id: "comment-updated" });
    mockCommentFindMany.mockResolvedValue([]);
    mockPublish.mockResolvedValue(undefined);
    mockAwardBid.mockResolvedValue({
      bidId: "bid-b",
      claimId: "claim-new",
      bugId: "bug-1",
    });
  });

  it("selects the bidder fairly (prioritizing fewest active claims) and directly assigns the task", async () => {
    mockBugFindMany.mockResolvedValue([sampleIssue]);
    mockIssueBidFindMany.mockResolvedValue([sampleBidA, sampleBidB]);

    // Alice (Bid A) already has 1 active task; Bob (Bid B) has 0 active tasks
    mockIssueClaimCount.mockImplementation(async ({ where }) => {
      if (where.beneficiaryUserId === "user-a" && where.status === "active" && where.releasedAt === null) {
        return 1;
      }
      return 0;
    });

    const res = await sweepPendingBids({ now: mockNow });

    expect(res.assigned).toBe(1);
    expect(res.invited).toBe(0);
    expect(res.errors).toHaveLength(0);

    // Direct award: Bob (BetaAgent) selected with 0 active tasks over Alice with 1 active task
    expect(mockAwardBid).toHaveBeenCalledWith(
      { id: "user-reporter", role: "super_admin" },
      "bid-b",
    );

    // #issue-bids: the award records itself (bid, claim, activity, event); the sweep posts no comment.
    expect(mockCommentCreate).not.toHaveBeenCalled();
    expect(mockBugActivityCreate).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("prioritizes bidders with fewer active claims but does not disqualify bidders holding active claims", async () => {
    mockBugFindMany.mockResolvedValue([sampleIssue]);
    mockIssueBidFindMany.mockResolvedValue([sampleBidA, sampleBidB]);

    // Alice has 2 active claims; Bob has 0
    mockIssueClaimCount.mockImplementation(async ({ where }) => {
      if (where.beneficiaryUserId === "user-a" && where.releasedAt === null) return 2;
      return 0;
    });

    const res = await sweepPendingBids({ now: mockNow });

    expect(res.assigned).toBe(1);
    expect(mockAwardBid).toHaveBeenCalledWith(
      expect.anything(),
      "bid-b",
    );
  });

  it("allows a bidder who has multiple active claims to still be directly assigned when they are the only bidder", async () => {
    mockBugFindMany.mockResolvedValue([sampleIssue]);
    mockIssueBidFindMany.mockResolvedValue([sampleBidA]);

    // Alice has 3 active claims
    mockIssueClaimCount.mockImplementation(async ({ where }) => {
      if (where.beneficiaryUserId === "user-a" && where.releasedAt === null) return 3;
      return 0;
    });

    const res = await sweepPendingBids({ now: mockNow });

    expect(res.assigned).toBe(1);
    expect(mockAwardBid).toHaveBeenCalledWith(
      expect.anything(),
      "bid-a",
    );
    expect(mockCommentCreate).not.toHaveBeenCalled();
  });

  it("prioritizes fewest historical tasks awarded when active claims are equal", async () => {
    mockBugFindMany.mockResolvedValue([sampleIssue]);
    mockIssueBidFindMany.mockResolvedValue([sampleBidA, sampleBidB]);

    // Both Alice and Bob have 0 active claims
    // Alice has 5 historical claims; Bob has 1 historical claim
    mockIssueClaimCount.mockImplementation(async ({ where }) => {
      if (where.status === "active") return 0;
      if (where.claimedAt && where.beneficiaryUserId === "user-a") return 5;
      if (where.claimedAt && where.beneficiaryUserId === "user-b") return 1;
      return 0;
    });

    const res = await sweepPendingBids({ now: mockNow });

    expect(res.assigned).toBe(1);
    expect(mockAwardBid).toHaveBeenCalledWith(
      expect.anything(),
      "bid-b",
    );
  });

  it("falls back to FIFO (earliest createdAt) when active and historical claims are equal", async () => {
    mockBugFindMany.mockResolvedValue([sampleIssue]);
    // sampleBidA was created at 10:00:00, sampleBidB was created at 10:05:00
    mockIssueBidFindMany.mockResolvedValue([sampleBidA, sampleBidB]);
    mockIssueClaimCount.mockResolvedValue(0);

    const res = await sweepPendingBids({ now: mockNow });

    expect(res.assigned).toBe(1);
    expect(mockAwardBid).toHaveBeenCalledWith(
      expect.anything(),
      "bid-a",
    );
  });

  it("ignores bids from revoked agents", async () => {
    const revokedBidA = {
      ...sampleBidA,
      agent: { ...sampleBidA.agent, revokedAt: new Date("2026-10-26T00:00:00.000Z") },
    };
    mockBugFindMany.mockResolvedValue([sampleIssue]);
    mockIssueBidFindMany.mockResolvedValue([revokedBidA, sampleBidB]);
    mockIssueClaimCount.mockResolvedValue(0);

    const res = await sweepPendingBids({ now: mockNow });

    expect(res.assigned).toBe(1);
    expect(mockAwardBid).toHaveBeenCalledWith(
      expect.anything(),
      "bid-b",
    );
  });

  it("leaves comments alone: nothing writes the old go-ahead handshake any more", async () => {
    mockBugFindMany.mockResolvedValue([sampleIssue]);
    mockIssueBidFindMany.mockResolvedValue([sampleBidB]);
    mockIssueClaimCount.mockResolvedValue(0);

    const res = await sweepPendingBids({ now: mockNow });

    expect(res.assigned).toBe(1);
    expect(mockCommentFindMany).not.toHaveBeenCalled();
    expect(mockCommentUpdate).not.toHaveBeenCalled();
  });

  it("records errors in result.errors when awardBid throws, without crashing the sweep", async () => {
    mockBugFindMany.mockResolvedValue([sampleIssue]);
    mockIssueBidFindMany.mockResolvedValue([sampleBidA]);
    mockIssueClaimCount.mockResolvedValue(0);

    mockAwardBid.mockRejectedValueOnce(new Error("Database deadlock during award"));

    const res = await sweepPendingBids({ now: mockNow });

    expect(res.assigned).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toEqual({
      issueId: "bug-1",
      error: "Database deadlock during award",
    });
  });
});
