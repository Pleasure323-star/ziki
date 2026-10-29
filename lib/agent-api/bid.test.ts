import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const mock = {
    bug: { findFirst: vi.fn(), update: vi.fn() },
    bugActivity: { createMany: vi.fn() },
    issueBid: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    issueClaim: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
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

import { isConfirmed } from "@/lib/agent-api/confirmations";
import { publish } from "@/lib/agent-api/events";
import { awardBid, listBids, placeBid, withdrawBid } from "./bid";
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

const openBug = {
  id: "issue1",
  title: "Broken login",
  projectId: "project",
  status: "open" as const,
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
  db.bug.findFirst.mockResolvedValue({ id: "issue1", projectId: "project", status: "open", voteCount: 3, convertedToIssueAt: new Date("2026-10-01T00:00:00Z") });
  db.issueClaim.findFirst.mockResolvedValue(null);
  db.issueClaim.count.mockResolvedValue(0);
  db.projectWorkflow.findUnique.mockResolvedValue(null);
  db.issueBid.updateMany.mockResolvedValue({ count: 1 });
  db.issueBid.findUnique.mockResolvedValue(null);
  db.issueBid.create.mockResolvedValue({ id: "bid1", beneficiaryUserId: "ada" });
  vi.mocked(isConfirmed).mockResolvedValue(true);
});

describe("placeBid", () => {
  it("records a bid and does not claim the issue", async () => {
    const bid = await placeBid(caller, "project", "issue1", "I can fix the login");
    expect(bid.id).toBe("bid1");
    expect(db.issueClaim.create).not.toHaveBeenCalled();
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.issueBid.create.mock.calls[0][0].data).toMatchObject({
      bugId: "issue1",
      agentId: "agent1",
      beneficiaryUserId: "ada",
      note: "I can fix the login",
    });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "issue.bid" }));
  });

  it("returns the open bid instead of creating another", async () => {
    db.issueBid.findUnique.mockResolvedValue({ id: "bid1", awardedAt: null, withdrawnAt: null });
    await expect(placeBid(caller, "project", "issue1")).resolves.toMatchObject({ id: "bid1" });
    expect(db.issueBid.create).not.toHaveBeenCalled();
  });

  it("allows bidding even when the agent's owner holds active claims", async () => {
    db.projectWorkflow.findUnique.mockResolvedValue({ maxActiveClaims: 1 });
    db.issueClaim.count.mockResolvedValue(5);
    await expect(placeBid(caller, "project", "issue1")).resolves.toMatchObject({ id: "bid1" });
    expect(db.issueBid.create).toHaveBeenCalled();
  });

  it("refuses an issue that is not confirmed yet", async () => {
    vi.mocked(isConfirmed).mockResolvedValue(false);
    await expect(placeBid(caller, "project", "issue1")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("not ready yet"),
    });
    expect(db.issueBid.create).not.toHaveBeenCalled();
  });

  it("refuses an issue that is not confirmed or is already being worked", async () => {
    vi.mocked(isConfirmed).mockResolvedValue(false);
    await expect(placeBid(caller, "project", "issue1")).rejects.toMatchObject({ status: 409 });
    vi.mocked(isConfirmed).mockResolvedValue(true);
    db.issueClaim.findFirst.mockResolvedValue({ id: "claim", status: "active", offeredAt: null, bug: { tenantId: "tenant", projectId: "project" } });
    await expect(placeBid(caller, "project", "issue1")).rejects.toMatchObject({ status: 409 });
    db.issueClaim.findFirst.mockResolvedValue({ id: "offer", status: "offered", offeredAt: new Date(), bug: { tenantId: "tenant", projectId: "project" } });
    await expect(placeBid(caller, "project", "issue1")).rejects.toMatchObject({
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
      { id: "bid-other", createdAt: new Date("2026-10-19T10:00:00Z"), agent: { name: "Other", areaPreferences: [] } },
      { id: "bid-match", createdAt: new Date("2026-10-19T11:00:00Z"), agent: { name: "Match", areaPreferences: [{ projectAreaId: "area-web" }] } },
    ]);
    const bids = await listBids(caller, "project", "issue1");
    expect(bids.map((bid) => bid.id)).toEqual(["bid-match", "bid-other"]);
    expect(bids.map((bid) => bid.areaMatch)).toEqual([true, false]);
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
    bug: openBug,
  };

  it("preserves the dispatcher owner on an auto-awarded claim", async () => {
    db.issueBid.findUnique.mockResolvedValue(stored);
    db.issueClaim.create.mockResolvedValue({ id: "claim1" });
    const dispatcher = { ...caller, ownerId: "dispatcher-owner", level: "manager" as const };
    await awardBid({ id: "reporter" }, "bid1", dispatcher);
    expect(db.issueClaim.create.mock.calls[0][0].data).toMatchObject({
      dispatcherUserId: "dispatcher-owner", beneficiaryUserId: "ada", status: "active",
    });
  });

  it("rejects forged dispatcher attribution from a lower-level caller", async () => {
    await expect(awardBid({ id: "reporter" }, "bid1", caller)).rejects.toThrow("This needs a manager agent.");
    expect(db.issueClaim.create).not.toHaveBeenCalled();
  });

  it("rejects dispatcher attribution from another tenant", async () => {
    db.issueBid.findUnique.mockResolvedValue(stored);
    await expect(awardBid({ id: "reporter" }, "bid1", {
      ...caller, tenantId: "another-tenant", level: "manager",
    })).rejects.toMatchObject({ status: 404 });
    expect(db.issueClaim.create).not.toHaveBeenCalled();
  });

  it("lets the reporter turn one bid into the active claim", async () => {
    db.issueBid.findUnique.mockResolvedValue(stored);
    db.issueClaim.create.mockResolvedValue({ id: "claim1" });
    await expect(awardBid({ id: "reporter" }, "bid1")).resolves.toEqual({
      bidId: "bid1",
      claimId: "claim1",
      bugId: "issue1",
    });
    expect(db.issueClaim.create.mock.calls[0][0].data).toMatchObject({
      status: "active",
      agentId: "agent1",
      beneficiaryUserId: "ada",
    });
    expect(db.bug.update.mock.calls[0][0].data).toEqual({ assigneeId: "ada", status: "in_progress" });
    expect(db.issueBid.updateMany).toHaveBeenCalledWith({
      where: { id: "bid1", awardedAt: null, withdrawnAt: null },
      data: expect.objectContaining({ claimId: "claim1" }),
    });
  });

  it("refuses someone who did not report the issue and is not an admin", async () => {
    db.issueBid.findUnique.mockResolvedValue(stored);
    await expect(awardBid({ id: "bob" }, "bid1")).rejects.toMatchObject({ status: 403 });
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
      where: { bugId: canonicalId, withdrawnAt: null, awardedAt: null },
    }));
  });

  it.each(["587", "ZE-587"])("locks and saves the canonical ID when bidding on %s", async (reference) => {
    db.bug.findFirst.mockResolvedValue({ id: canonicalId, projectId: "project", status: "open", voteCount: 3, convertedToIssueAt: new Date("2026-10-01T00:00:00Z") });
    db.$queryRaw.mockResolvedValue([{ id: canonicalId }]);

    await placeBid(caller, "project", reference, "I can fix it");

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
      bugId: canonicalId, agentId: "agent1", beneficiaryUserId: "ada", note: "I can fix it",
    } });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      bugId: canonicalId,
      payload: expect.objectContaining({ issueId: canonicalId, projectId: "project" }),
    }));
  });

  it("keeps canonical references working without a numeric lookup", async () => {
    db.bug.findFirst.mockResolvedValue({ id: canonicalId, projectId: "project", status: "open", voteCount: 3, convertedToIssueAt: new Date("2026-10-01T00:00:00Z") });
    db.$queryRaw.mockResolvedValue([{ id: canonicalId }]);
    await placeBid(caller, "project", canonicalId);
    expect(db.bug.findFirst).toHaveBeenCalledTimes(1);
    expect(db.bug.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: canonicalId, tenantId: "tenant", projectId: "project", isDeleted: false },
    }));
    expect(db.$queryRaw.mock.calls[0].slice(1)).toEqual([canonicalId, "tenant", "project"]);
  });

  it.each([listBids, placeBid])("does not access bids for a missing, deleted, or differently scoped numeric issue", async (operation) => {
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
    await expect(placeBid(caller, "project", "587")).rejects.toMatchObject({ status: 404 });
    expect(db.issueBid.create).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([listBids, placeBid])("rejects another project before resolving a numeric issue for a project-scoped key", async (operation) => {
    await expect(operation({ ...caller, projectId: "key-project" }, "project", "587")).rejects.toThrow();
    expect(db.bug.findFirst).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.issueBid.create).not.toHaveBeenCalled();
  });
});
