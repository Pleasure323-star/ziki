import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const mock = {
    bug: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    bugActivity: { createMany: vi.fn(), create: vi.fn() },
    issueBid: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    issueClaim: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
    bidVote: { findMany: vi.fn(), deleteMany: vi.fn() },
    agent: { findFirst: vi.fn() },
    projectWorkflow: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  mock.$transaction.mockImplementation((fn: (tx: typeof mock) => unknown) => fn(mock));
  return mock;
});
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/confirmations", () => ({ isConfirmed: vi.fn(async () => true) }));
vi.mock("@/lib/redesigns", () => ({ assertRedesignOpen: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-api/events", () => ({ publish: vi.fn(async () => ({ id: "evt" })) }));
vi.mock("@/lib/watch", () => ({ ensureWatching: vi.fn(async () => undefined) }));
vi.mock("@/lib/agents/membership", () => ({ isTenantAdmin: vi.fn(async () => false) }));
vi.mock("@/lib/agent-notifications", () => ({ notifyClaimOffered: vi.fn() }));
vi.mock("@/lib/agent-api/offer", async (original) => ({
  ...await original<typeof import("@/lib/agent-api/offer")>(),
  scheduleOfferExpiry: vi.fn(),
}));

import { isConfirmed } from "@/lib/agent-api/confirmations";
import { publish } from "@/lib/agent-api/events";
import { notifyClaimOffered } from "@/lib/agent-notifications";
import { scheduleOfferExpiry } from "@/lib/agent-api/offer";
import { awardBid, listBids, parseBid, placeBid, withdrawBid } from "./bid";
import { resetWorkflowCache } from "@/lib/workflow";

const caller = {
  agentId: "agent1",
  name: "Ada's Claude",
  ownerId: "ada",
  tenantId: "tenant",
  level: "working" as const,
  burst: false,
  keyId: "key1",
};

const plan = { summary: "I can fix the login.", description: "The session cookie is dropped on redirect; I will keep it and add a test." };
const placePlan = (c: Parameters<typeof placeBid>[0], project: string, ref: string) => placeBid(c, project, ref, plan);

const openBug = {
  id: "issue1",
  title: "Broken login",
  projectId: "project",
  status: "open", substatus: "open" as const,
  assigneeId: null,
  tenantId: "tenant",
  reporterId: "reporter",
  isDeleted: false,
  voteCount: 3,
  convertedToIssueAt: new Date("2026-10-01T00:00:00Z"),
  assignee: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkflowCache();
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  db.$queryRaw.mockResolvedValue([{ id: "issue1" }]);
  db.bug.findFirst.mockResolvedValue({ id: "issue1", projectId: "project", status: "open", substatus: "open", voteCount: 3, convertedToIssueAt: new Date("2026-10-01T00:00:00Z") });
  db.issueClaim.findFirst.mockResolvedValue(null);
  db.issueClaim.count.mockResolvedValue(0);
  db.projectWorkflow.findUnique.mockResolvedValue(null);
  db.agent.findFirst.mockResolvedValue(null);
  db.issueBid.updateMany.mockResolvedValue({ count: 1 });
  db.bug.updateMany.mockResolvedValue({ count: 1 });
  db.issueBid.findUnique.mockResolvedValue(null);
  db.issueBid.create.mockResolvedValue({ id: "bid1", beneficiaryUserId: "ada", summary: plan.summary });
  // By default a bid has one manager agent's vote: 3, the default awardThreshold.
  db.bidVote.findMany.mockResolvedValue([{ onBehalfOfUserId: "eve", agent: { level: "manager" } }]);
  vi.mocked(isConfirmed).mockResolvedValue(true);
});

describe("placeBid", () => {
  it("records a bid and does not claim the issue", async () => {
    const { bid, replaced } = await placeBid(caller, "project", "issue1", plan);
    expect(bid.id).toBe("bid1");
    expect(replaced).toBe(false);
    expect(db.issueClaim.create).not.toHaveBeenCalled();
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.issueBid.create.mock.calls[0][0].data).toMatchObject({
      bugId: "issue1",
      agentId: "agent1",
      beneficiaryUserId: "ada",
      summary: plan.summary,
      description: plan.description,
    });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "issue.bid" }));
  });

  it("bidding again replaces the agent's open bid instead of creating another", async () => {
    db.issueBid.findUnique.mockResolvedValue({ id: "bid1", awardedAt: null, withdrawnAt: null, summary: "Old.", description: "Old plan." });
    db.issueBid.update.mockResolvedValue({ id: "bid1", summary: "New plan.", description: "Better plan." });
    const result = await placeBid(caller, "project", "issue1", { summary: "New plan.", description: "Better plan." });
    expect(result).toMatchObject({ bid: { id: "bid1", summary: "New plan." }, replaced: true });
    expect(db.issueBid.update).toHaveBeenCalledWith({ where: { id: "bid1" }, data: { summary: "New plan.", description: "Better plan." } });
    expect(db.issueBid.create).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("bidding after withdrawing reopens the same bid with the new text", async () => {
    db.issueBid.findUnique.mockResolvedValue({ id: "bid1", awardedAt: null, withdrawnAt: new Date(), summary: "Old.", description: "Old plan." });
    db.issueBid.update.mockResolvedValue({ id: "bid1", beneficiaryUserId: "ada", summary: plan.summary });
    const result = await placeBid(caller, "project", "issue1", plan);
    expect(result.replaced).toBe(false);
    expect(db.issueBid.update).toHaveBeenCalledWith({
      where: { id: "bid1" },
      data: { ...plan, withdrawnAt: null, beneficiaryUserId: "ada" },
    });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "issue.bid" }));
  });

  it("bids afresh once an earlier award's hold has ended and the issue is Open again (#745)", async () => {
    const awardedAt = new Date("2026-10-30T10:00:00Z");
    db.issueBid.findUnique.mockResolvedValue({ id: "bid1", awardedAt, claimId: "old-claim", withdrawnAt: null });
    db.issueBid.update.mockResolvedValue({ id: "bid1", summary: plan.summary });
    // No live offer or claim on the issue: the old award's hold is over.
    db.issueClaim.findFirst.mockResolvedValue(null);
    const result = await placePlan(caller, "project", "issue1");
    expect(result).toMatchObject({ bid: { id: "bid1" }, replaced: false });
    expect(db.issueBid.update).toHaveBeenCalledWith({
      where: { id: "bid1" },
      data: expect.objectContaining({ awardedAt: null, claimId: null, withdrawnAt: null, summary: plan.summary }),
    });
    // The old round's votes don't carry over to the new bid.
    expect(db.bidVote.deleteMany).toHaveBeenCalledWith({ where: { bidId: "bid1" } });
    expect(db.issueBid.create).not.toHaveBeenCalled();
  });

  it("still refuses a rebid while the awarded offer or claim is live (#745)", async () => {
    db.issueBid.findUnique.mockResolvedValue({ id: "bid1", awardedAt: new Date(), claimId: "claim", withdrawnAt: null });
    db.issueClaim.findFirst.mockResolvedValue({ id: "claim", status: "active", offeredAt: null, bug: { tenantId: "tenant", projectId: "project" } });
    await expect(placePlan(caller, "project", "issue1")).rejects.toMatchObject({ status: 409 });
    db.issueClaim.findFirst.mockResolvedValue({ id: "claim", status: "offered", offeredAt: new Date(), bug: { tenantId: "tenant", projectId: "project" } });
    await expect(placePlan(caller, "project", "issue1")).rejects.toMatchObject({ status: 409 });
    expect(db.issueBid.update).not.toHaveBeenCalled();
    expect(db.bidVote.deleteMany).not.toHaveBeenCalled();
  });

  it("allows bidding even when the agent's owner holds active claims", async () => {
    db.projectWorkflow.findUnique.mockResolvedValue({ maxActiveClaims: 1 });
    db.issueClaim.count.mockResolvedValue(5);
    await expect(placePlan(caller, "project", "issue1")).resolves.toMatchObject({ bid: { id: "bid1" } });
    expect(db.issueBid.create).toHaveBeenCalled();
  });

  it("refuses an issue that is not confirmed yet", async () => {
    vi.mocked(isConfirmed).mockResolvedValue(false);
    await expect(placePlan(caller, "project", "issue1")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("not ready yet"),
    });
    expect(db.issueBid.create).not.toHaveBeenCalled();
  });

  it("refuses an issue that is not confirmed or is already being worked", async () => {
    vi.mocked(isConfirmed).mockResolvedValue(false);
    await expect(placePlan(caller, "project", "issue1")).rejects.toMatchObject({ status: 409 });
    vi.mocked(isConfirmed).mockResolvedValue(true);
    db.issueClaim.findFirst.mockResolvedValue({ id: "claim", status: "active", offeredAt: null, bug: { tenantId: "tenant", projectId: "project" } });
    await expect(placePlan(caller, "project", "issue1")).rejects.toMatchObject({ status: 409 });
    db.issueClaim.findFirst.mockResolvedValue({ id: "offer", status: "offered", offeredAt: new Date(), bug: { tenantId: "tenant", projectId: "project" } });
    await expect(placePlan(caller, "project", "issue1")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("pending offer"),
    });
    expect(db.issueBid.create).not.toHaveBeenCalled();
  });
});

describe("listBids area preference (#609)", () => {
  it("ranks matching-area volunteers first without hiding other bids", async () => {
    db.bug.findFirst.mockResolvedValue({ id: "issue1", areaId: "area-web" });
    db.issueBid.findMany.mockResolvedValue([
      { id: "bid-other", createdAt: new Date("2026-10-19T10:00:00Z"), beneficiary: { name: "Owner" }, replies: [], agent: { name: "Other", areaPreferences: [] } },
      { id: "bid-match", createdAt: new Date("2026-10-19T11:00:00Z"), beneficiary: { name: "Owner" }, replies: [], agent: { name: "Match", areaPreferences: [{ projectAreaId: "area-web" }] } },
    ]);
    const bids = await listBids(caller, "project", "issue1");
    expect(bids.map((bid) => bid.id)).toEqual(["bid-match", "bid-other"]);
    expect(bids.map((bid) => bid.areaMatch)).toEqual([true, false]);
  });

  it("carries each bid's summary, description, owner and replies, open bids from live agents only", async () => {
    db.bug.findFirst.mockResolvedValue({ id: "issue1", areaId: null });
    db.issueBid.findMany.mockResolvedValue([{
      id: "bid1", agentId: "agent1", beneficiaryUserId: "ada", summary: "S.", description: "D.",
      createdAt: new Date("2026-10-19T10:00:00Z"), updatedAt: new Date("2026-10-19T10:00:00Z"),
      beneficiary: { name: "Ada" }, agent: { name: "Ada's Claude", areaPreferences: [] },
      replies: [{ id: "c1", body: "Go.", authorId: "rep", agentId: null, createdAt: new Date(), editedAt: null, author: { name: "Rita" }, agent: null }],
    }]);
    const [bid] = await listBids(caller, "project", "issue1");
    expect(bid).toMatchObject({ agentName: "Ada's Claude", by: "Ada", summary: "S.", description: "D.", replies: [{ id: "c1", authorName: "Rita", agentName: null }] });
    expect(db.issueBid.findMany.mock.calls[0][0].where).toEqual({ bugId: "issue1", withdrawnAt: null, awardedAt: null, agent: { revokedAt: null } });
  });

  it("weighs each bid's votes: a manager or merger agent's counts managerVoteWeight, one per person (#bid-votes)", async () => {
    db.bug.findFirst.mockResolvedValue({ id: "issue1", areaId: null });
    db.issueBid.findMany.mockResolvedValue([{
      id: "bid1", createdAt: new Date("2026-10-19T10:00:00Z"), beneficiary: { name: "Ada" }, replies: [],
      agent: { name: "Ada's Claude", areaPreferences: [] }, bug: { projectId: "project" },
      votes: [
        { onBehalfOfUserId: "dana", agent: { level: "manager" } },
        { onBehalfOfUserId: "bob", agent: { level: "working" } },
      ],
    }]);
    const [bid] = await listBids(caller, "project", "issue1");
    expect(bid.votes).toBe(4);
    expect(bid).not.toHaveProperty("bug");
  });
});

describe("parseBid (#issue-bids)", () => {
  it("takes a summary and a description", () => {
    expect(parseBid({ summary: " I will fix it. ", description: " Plan. ", projectId: "p" })).toEqual({ summary: "I will fix it.", description: "Plan.", projectId: "p" });
  });

  it.each([
    [{}, "summary"],
    [{ summary: "I will fix it." }, "description"],
    [{ description: "Plan." }, "summary"],
    [{ summary: "", description: "Plan." }, "summary"],
    [{ summary: "One. Two. Three.", description: "Plan." }, "summary"],
    [{ summary: "x".repeat(301), description: "Plan." }, "summary"],
    [{ summary: "S.", description: "x".repeat(10_001) }, "description"],
  ])("refuses a bare or oversized bid %j with a 400 naming %s", (body, field) => {
    expect(() => parseBid(body)).toThrow(expect.objectContaining({ status: 400, body: expect.objectContaining({ field }) }));
  });

  it("refuses an unknown field, naming summary and description", () => {
    expect(() => parseBid({ note: "I can fix it" })).toThrow(expect.objectContaining({
      status: 400,
      body: expect.objectContaining({ message: expect.stringContaining("summary") }),
    }));
  });
});

describe("awardBid", () => {
  const stored = {
    id: "bid1",
    bugId: "issue1",
    agentId: "agent1",
    beneficiaryUserId: "ada",
    withdrawnAt: null,
    awardedAt: null,
    beneficiary: { name: "Ada" },
    agent: { ownerUserId: "ada" },
    bug: openBug,
  };
  const manager = { ...caller, agentId: "dana-agent", name: "Dana's Claude", ownerId: "dana", level: "manager" as const };

  it("awards a bid at the threshold as an offered claim to the bidding agent, attributed to the awarding agent", async () => {
    db.issueBid.findUnique.mockResolvedValue(stored);
    db.issueClaim.create.mockResolvedValue({ id: "claim1" });
    await expect(awardBid(manager, "bid1")).resolves.toEqual({
      bidId: "bid1",
      claimId: "claim1",
      bugId: "issue1",
      bugTitle: "Broken login",
      beneficiaryUserId: "ada",
    });
    expect(db.issueClaim.create.mock.calls[0][0].data).toMatchObject({
      status: "offered",
      offeredAt: expect.any(Date),
      agentId: "agent1",
      beneficiaryUserId: "ada",
    });
    // Picking a bid is not dispatching: whoever awarded it is not recorded as dispatcher.
    expect(db.issueClaim.create.mock.calls[0][0].data).not.toHaveProperty("dispatcherUserId");
    // An offer: the issue stays Open with no assignee, and the other bids stay open.
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.issueBid.updateMany).toHaveBeenCalledTimes(1);
    expect(db.issueBid.updateMany).toHaveBeenCalledWith({
      where: { id: "bid1", awardedAt: null, withdrawnAt: null },
      data: expect.objectContaining({ awardedAt: expect.any(Date), claimId: "claim1" }),
    });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "claim.offered",
      payload: expect.objectContaining({ claimId: "claim1", bidId: "bid1", expiresAt: expect.any(String) }),
    }));
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "issue.bid_awarded",
      payload: expect.objectContaining({ bidId: "bid1", claimId: "claim1", offered: true, awardedByAgentId: "dana-agent" }),
    }));
    expect(notifyClaimOffered).toHaveBeenCalledWith({ id: "claim1", bugId: "issue1", bugTitle: "Broken login", beneficiaryUserId: "ada" });
    expect(scheduleOfferExpiry).toHaveBeenCalledWith("claim1");
  });

  it("lets a merger agent award a bid too", async () => {
    db.issueBid.findUnique.mockResolvedValue(stored);
    db.issueClaim.create.mockResolvedValue({ id: "claim1" });
    await expect(awardBid({ ...manager, level: "merger" }, "bid1")).resolves.toMatchObject({ claimId: "claim1" });
  });

  it("lets any agent award a bid at the threshold, a working agent too (#bid-votes)", async () => {
    db.issueBid.findUnique.mockResolvedValue({ ...stored, beneficiaryUserId: "bob", agent: { ownerUserId: "bob" } });
    db.issueClaim.create.mockResolvedValue({ id: "claim1" });
    const working = { ...caller, agentId: "cara-agent", ownerId: "cara" };
    await expect(awardBid(working, "bid1")).resolves.toMatchObject({ claimId: "claim1", beneficiaryUserId: "bob" });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "issue.bid_awarded",
      payload: expect.objectContaining({ awardedByAgentId: "cara-agent" }),
    }));
  });

  it("lets an agent award its own owner's bid once it reached the threshold", async () => {
    for (const bid of [{ ...stored, beneficiaryUserId: "dana" }, { ...stored, agent: { ownerUserId: "dana" } }]) {
      vi.clearAllMocks();
      db.issueBid.updateMany.mockResolvedValue({ count: 1 });
      db.issueBid.findUnique.mockResolvedValue(bid);
      db.issueClaim.create.mockResolvedValue({ id: "claim1" });
      await expect(awardBid(manager, "bid1")).resolves.toMatchObject({ claimId: "claim1" });
    }
  });

  it("refuses every award below the threshold, a manager's too, with 409 below_threshold", async () => {
    db.issueBid.findUnique.mockResolvedValue(stored);
    // Two working agents' votes: 2 of 3.
    db.bidVote.findMany.mockResolvedValue([
      { onBehalfOfUserId: "bob", agent: { level: "working" } },
      { onBehalfOfUserId: "cara", agent: { level: "working" } },
    ]);
    for (const agent of [caller, manager, { ...manager, level: "merger" as const }]) {
      await expect(awardBid(agent, "bid1")).rejects.toMatchObject({
        status: 409,
        body: { error: "below_threshold", message: expect.stringContaining("2 of the 3 votes"), votes: 2, threshold: 3 },
      });
    }
    // No votes at all.
    db.bidVote.findMany.mockResolvedValue([]);
    await expect(awardBid(manager, "bid1")).rejects.toMatchObject({ status: 409, body: expect.objectContaining({ error: "below_threshold", votes: 0 }) });
    expect(db.issueClaim.create).not.toHaveBeenCalled();
    expect(notifyClaimOffered).not.toHaveBeenCalled();
  });

  it("counts each person once, at the highest weight any of their agents cast", async () => {
    db.issueBid.findUnique.mockResolvedValue(stored);
    db.bidVote.findMany.mockResolvedValue([
      { onBehalfOfUserId: "bob", agent: { level: "working" } },
      { onBehalfOfUserId: "bob", agent: { level: "working" } },
    ]);
    await expect(awardBid(manager, "bid1")).rejects.toMatchObject({ body: expect.objectContaining({ votes: 1 }) });
  });

  it("refuses a bid from another tenant as not found", async () => {
    db.issueBid.findUnique.mockResolvedValue(stored);
    await expect(awardBid({ ...manager, tenantId: "another-tenant" }, "bid1")).rejects.toMatchObject({ status: 404 });
    expect(db.issueClaim.create).not.toHaveBeenCalled();
  });

  it("refuses a bid outside the key's project", async () => {
    db.issueBid.findUnique.mockResolvedValue(stored);
    await expect(awardBid({ ...manager, projectId: "other-project" }, "bid1")).rejects.toThrow("restricted");
    expect(db.issueClaim.create).not.toHaveBeenCalled();
  });

  it("refuses a bid that is no longer open, or an issue with a pending offer", async () => {
    db.issueBid.findUnique.mockResolvedValue({ ...stored, withdrawnAt: new Date() });
    await expect(awardBid(manager, "bid1")).rejects.toMatchObject({ status: 409, message: "This bid is no longer open." });
    db.issueBid.findUnique.mockResolvedValue(stored);
    db.issueClaim.findFirst.mockImplementation(async ({ where }: { where: { status?: string } }) =>
      where.status === "active" ? null : { id: "offer", status: "offered", offeredAt: new Date(), agentId: "x", beneficiaryUserId: "x", bug: { tenantId: "tenant", projectId: "project" } });
    await expect(awardBid(manager, "bid1")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("pending offer") });
    expect(db.issueClaim.create).not.toHaveBeenCalled();
  });
});

describe("awardBid and bidder capacity (#bidder-capacity)", () => {
  const manager = { ...caller, agentId: "dana-agent", name: "Dana's Claude", ownerId: "dana", level: "manager" as const };
  const stored = {
    id: "bid1",
    bugId: "issue1",
    agentId: "agent1",
    beneficiaryUserId: "ada",
    withdrawnAt: null,
    awardedAt: null,
    beneficiary: { name: "Ada" },
    agent: { ownerUserId: "ada" },
    bug: openBug,
  };

  it("refuses with 409 at_capacity when the bidder already holds the project's limit of live offers and active claims", async () => {
    db.issueBid.findUnique.mockResolvedValue(stored);
    db.projectWorkflow.findUnique.mockResolvedValue({ maxActiveClaims: 2 });
    db.issueClaim.count.mockResolvedValue(2);
    await expect(awardBid(manager, "bid1")).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ error: "at_capacity", load: 2, capacity: 2 }),
    });
    // Counted over the bidder's person in this project, offers inside the window and active claims.
    expect(db.issueClaim.count).toHaveBeenCalledWith({ where: expect.objectContaining({
      beneficiaryUserId: "ada",
      bug: { tenantId: "tenant", projectId: "project", isDeleted: false },
      releasedAt: null,
      OR: expect.arrayContaining([{ status: "active" }]),
    }) });
    expect(db.issueClaim.create).not.toHaveBeenCalled();
    expect(db.bug.updateMany).not.toHaveBeenCalled();
    expect(notifyClaimOffered).not.toHaveBeenCalled();
  });

  it("awards a bid whose bidder is under capacity", async () => {
    db.issueBid.findUnique.mockResolvedValue(stored);
    db.projectWorkflow.findUnique.mockResolvedValue({ maxActiveClaims: 2 });
    db.issueClaim.count.mockResolvedValue(1);
    db.issueClaim.create.mockResolvedValue({ id: "claim1" });
    await expect(awardBid(manager, "bid1")).resolves.toMatchObject({ claimId: "claim1" });
  });
});

describe("awardBid and a stale assignee (#stale-assignee)", () => {
  const manager = { ...caller, agentId: "dana-agent", name: "Dana's Claude", ownerId: "dana", level: "manager" as const };
  const assignedBug = { ...openBug, assigneeId: "carl", assignee: { name: "Carl" } };
  const stored = {
    id: "bid1",
    bugId: "issue1",
    agentId: "agent1",
    beneficiaryUserId: "ada",
    withdrawnAt: null,
    awardedAt: null,
    beneficiary: { name: "Ada" },
    agent: { ownerUserId: "ada" },
    bug: assignedBug,
  };

  it("clears an assignee with no active claim and no live offer, records it, then awards", async () => {
    db.issueBid.findUnique.mockResolvedValue(stored);
    db.issueClaim.create.mockResolvedValue({ id: "claim1" });
    await expect(awardBid(manager, "bid1")).resolves.toMatchObject({ claimId: "claim1", bugId: "issue1" });
    expect(db.bug.updateMany).toHaveBeenCalledWith({
      where: { id: "issue1", assigneeId: "carl", substatus: "open" },
      data: { assigneeId: null },
    });
    expect(db.bugActivity.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      bugId: "issue1",
      actorId: "dana",
      type: "assignee_changed",
      metadata: expect.objectContaining({ field: "assignee", from: "carl", to: null }),
    }) });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "issue.updated",
      payload: expect.objectContaining({ values: { assigneeId: null }, reason: "stale_assignee" }),
    }));
    expect(db.issueClaim.create).toHaveBeenCalledTimes(1);
  });

  it("counts an offer past the project's window as no hold, so its assignee is stale too", async () => {
    db.issueBid.findUnique.mockResolvedValue(stored);
    db.issueClaim.create.mockResolvedValue({ id: "claim1" });
    // The live-hold query only matches offers inside the window; the expired one is not returned.
    db.issueClaim.findFirst.mockImplementation(async ({ where }: { where: { OR?: unknown; status?: string } }) =>
      where.OR || where.status === "active" ? null
        : { id: "old-offer", status: "offered", offeredAt: new Date(Date.now() - 2 * 3600_000), agentId: "x", beneficiaryUserId: "carl", bug: { tenantId: "tenant", projectId: "project" } });
    await expect(awardBid(manager, "bid1")).resolves.toMatchObject({ claimId: "claim1" });
    expect(db.bug.updateMany).toHaveBeenCalledTimes(1);
  });

  it("still refuses when the assignee holds an active claim", async () => {
    db.issueBid.findUnique.mockResolvedValue(stored);
    db.issueClaim.findFirst.mockImplementation(async ({ where }: { where: { OR?: unknown } }) =>
      where.OR ? { id: "held", status: "active", beneficiaryUserId: "carl" } : null);
    await expect(awardBid(manager, "bid1")).rejects.toMatchObject({ status: 409, message: "This issue is already assigned to someone else." });
    expect(db.bug.updateMany).not.toHaveBeenCalled();
    expect(db.bugActivity.create).not.toHaveBeenCalled();
    expect(db.issueClaim.create).not.toHaveBeenCalled();
  });

  it("still refuses when the assignee holds a live offer", async () => {
    db.issueBid.findUnique.mockResolvedValue(stored);
    db.issueClaim.findFirst.mockImplementation(async ({ where }: { where: { OR?: unknown } }) =>
      where.OR ? { id: "offer", status: "offered", beneficiaryUserId: "carl" } : null);
    await expect(awardBid(manager, "bid1")).rejects.toMatchObject({ status: 409 });
    expect(db.bug.updateMany).not.toHaveBeenCalled();
    expect(db.issueClaim.create).not.toHaveBeenCalled();
  });
});

describe("withdrawBid", () => {
  it("withdraws the caller's open bid", async () => {
    db.issueBid.findUnique.mockResolvedValue({
      id: "bid1",
      awardedAt: null,
      withdrawnAt: null,
      bug: { tenantId: "tenant", projectId: "project", isDeleted: false },
    });
    await withdrawBid(caller, "project", "issue1");
    expect(db.issueBid.updateMany.mock.calls[0][0].data.withdrawnAt).toBeInstanceOf(Date);
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "issue.bid_withdrawn" }));
  });
});


describe("readable bid references (#587)", () => {
  const canonicalId = "cmvcanonicalissue587";

  it.each(["587", "ZE-587"])("lists bids for %s using the scoped canonical issue ID", async (reference) => {
    db.bug.findFirst.mockResolvedValue({ id: canonicalId, areaId: null });
    db.issueBid.findMany.mockResolvedValue([]);

    await expect(listBids(caller, "project", reference)).resolves.toEqual([]);
    expect(db.bug.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { number: 587, tenantId: "tenant", projectId: "project", isDeleted: false },
    }));
    expect(db.issueBid.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { bugId: canonicalId, withdrawnAt: null, awardedAt: null, agent: { revokedAt: null } },
    }));
  });

  it.each(["587", "ZE-587"])("locks and saves the canonical ID when bidding on %s", async (reference) => {
    db.bug.findFirst.mockResolvedValue({ id: canonicalId, projectId: "project", status: "open", substatus: "open", voteCount: 3, convertedToIssueAt: new Date("2026-10-01T00:00:00Z") });
    db.$queryRaw.mockResolvedValue([{ id: canonicalId }]);

    await placeBid(caller, "project", reference, plan);

    expect(db.bug.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { number: 587, tenantId: "tenant", projectId: "project", isDeleted: false },
    }));
    const [sql, ...values] = db.$queryRaw.mock.calls[0];
    expect(Array.from(sql as TemplateStringsArray).join("?")).toContain("FOR UPDATE");
    expect(values).toEqual([canonicalId, "tenant", "project"]);
    expect(isConfirmed).toHaveBeenCalledWith(canonicalId, db);
    expect(db.issueClaim.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { bugId: canonicalId, releasedAt: null },
    }));
    expect(db.issueBid.findUnique).toHaveBeenCalledWith({
      where: { bugId_agentId: { bugId: canonicalId, agentId: "agent1" } },
    });
    expect(db.issueBid.create).toHaveBeenCalledWith({ data: {
      bugId: canonicalId, agentId: "agent1", beneficiaryUserId: "ada", ...plan,
    } });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      bugId: canonicalId,
      payload: expect.objectContaining({ issueId: canonicalId, projectId: "project" }),
    }));
  });

  it("keeps canonical references working without a numeric lookup", async () => {
    db.bug.findFirst.mockResolvedValue({ id: canonicalId, projectId: "project", status: "open", substatus: "open", voteCount: 3, convertedToIssueAt: new Date("2026-10-01T00:00:00Z") });
    db.$queryRaw.mockResolvedValue([{ id: canonicalId }]);
    await placePlan(caller, "project", canonicalId);
    expect(db.bug.findFirst).toHaveBeenCalledTimes(1);
    expect(db.bug.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: canonicalId, tenantId: "tenant", projectId: "project", isDeleted: false },
    }));
    expect(db.$queryRaw.mock.calls[0].slice(1)).toEqual([canonicalId, "tenant", "project"]);
  });

  it.each([listBids, placePlan])("does not access bids for a missing, deleted, or differently scoped numeric issue", async (operation) => {
    db.bug.findFirst.mockResolvedValue(null);
    await expect(operation(caller, "project", "587")).rejects.toMatchObject({ status: 404 });
    expect(db.bug.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { number: 587, tenantId: "tenant", projectId: "project", isDeleted: false },
    }));
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.issueBid.findMany).not.toHaveBeenCalled();
    expect(db.issueBid.create).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("rechecks scoped issue existence after taking the lock", async () => {
    db.bug.findFirst.mockResolvedValueOnce({ id: canonicalId }).mockResolvedValueOnce(null);
    db.$queryRaw.mockResolvedValue([{ id: canonicalId }]);
    await expect(placePlan(caller, "project", "587")).rejects.toMatchObject({ status: 404 });
    expect(db.issueBid.create).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([listBids, placePlan])("rejects another project before resolving a numeric issue for a project-scoped key", async (operation) => {
    await expect(operation({ ...caller, projectId: "key-project" }, "project", "587")).rejects.toThrow();
    expect(db.bug.findFirst).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.issueBid.create).not.toHaveBeenCalled();
  });
});
