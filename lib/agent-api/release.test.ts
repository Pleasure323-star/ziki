import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  issueClaim: { findFirst: vi.fn(), update: vi.fn(), count: vi.fn(), create: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
  bug: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), update: vi.fn() },
  bugActivity: { createMany: vi.fn() },
  membership: { findMany: vi.fn() },
  agentEvent: { create: vi.fn() },
  webhookSubscription: { findMany: vi.fn() },
  webhookDelivery: { createMany: vi.fn() },
}));
const isConfirmed = vi.hoisted(() => vi.fn());
const notifyClaimOffered = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/confirmations", () => ({ isConfirmed }));
vi.mock("@/lib/agent-notifications", () => ({ notifyClaimOffered }));
vi.mock("@/lib/redesigns", () => ({ assertRedesignOpen: vi.fn() }));

import { releaseClaim } from "./offer";

const agent = { agentId: "agent-ada", name: "Ada's Claude", ownerId: "ada", tenantId: "tenant", level: "working" as const, burst: false, keyId: "k" };

function claim(status: "offered" | "active") {
  return { id: "claim-1", bugId: "bug1", agentId: "agent-ada", beneficiaryUserId: "ada", status, beneficiary: { name: "Ada" } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw.mockResolvedValue([{ id: "bug1" }]);
  db.issueClaim.count.mockResolvedValue(0);
  db.issueClaim.groupBy.mockResolvedValue([]);
  db.issueClaim.findMany.mockResolvedValue([]);
  db.agentEvent.create.mockResolvedValue({ id: "evt" });
  db.webhookSubscription.findMany.mockResolvedValue([]);
  db.membership.findMany.mockResolvedValue([]);
  isConfirmed.mockResolvedValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("an agent gives work back (#547)", () => {
  it("declines a pending offer", async () => {
    db.issueClaim.findFirst.mockResolvedValue(claim("offered"));
    db.bug.findFirstOrThrow.mockResolvedValue({ id: "bug1", title: "T", status: "open", assigneeId: null, projectId: "p" });

    const result = await releaseClaim(agent, "p", "bug1", "Not my area");

    expect(result).toMatchObject({ claimId: "claim-1", reason: "declined", reopened: false, reofferedTo: null });
    expect(db.issueClaim.update).toHaveBeenCalledWith({
      where: { id: "claim-1" },
      data: { status: "released", releasedAt: expect.any(Date), releaseReason: "declined" },
    });
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.agentEvent.create.mock.calls[0][0].data).toMatchObject({
      type: "claim.released",
      payload: expect.objectContaining({ reason: "declined", note: "Not my area" }),
    });
  });

  it("releases an active claim and reopens the issue", async () => {
    db.issueClaim.findFirst.mockResolvedValue(claim("active"));
    db.bug.findFirstOrThrow.mockResolvedValue({ id: "bug1", title: "T", status: "in_progress", assigneeId: "ada", projectId: "p" });

    const result = await releaseClaim(agent, "p", "bug1");

    expect(result).toMatchObject({ reason: "agent", reopened: true });
    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { assigneeId: null, status: "open" } });
    expect(db.bugActivity.createMany).toHaveBeenCalled();
  });

  it("leaves a reassigned or resolved issue alone", async () => {
    db.issueClaim.findFirst.mockResolvedValue(claim("active"));
    db.bug.findFirstOrThrow.mockResolvedValue({ id: "bug1", title: "T", status: "resolved", assigneeId: "ada", projectId: "p" });

    const result = await releaseClaim(agent, "p", "bug1");

    expect(result.reopened).toBe(false);
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(isConfirmed).not.toHaveBeenCalled();
  });

  it("offers the issue to someone else, never back to the same person", async () => {
    db.$queryRaw.mockResolvedValueOnce([{ id: "bug1" }]).mockResolvedValueOnce([{ id: "bob" }]);
    db.issueClaim.findFirst.mockResolvedValueOnce(claim("active")).mockResolvedValueOnce(null);
    db.bug.findFirstOrThrow.mockResolvedValue({ id: "bug1", title: "T", status: "in_progress", assigneeId: "ada", projectId: "p" });
    isConfirmed.mockResolvedValue(true);
    db.membership.findMany.mockResolvedValue([
      { userId: "ada", user: { agents: [{ id: "agent-ada" }] } },
      { userId: "bob", user: { agents: [{ id: "agent-bob" }] } },
    ]);
    db.issueClaim.create.mockResolvedValue({ id: "claim-2", bugId: "bug1", offeredAt: new Date() });

    const result = await releaseClaim(agent, "p", "bug1");

    expect(result.reofferedTo).toBe("bob");
    expect(db.issueClaim.create.mock.calls[0][0].data).toMatchObject({ beneficiaryUserId: "bob", agentId: "agent-bob", status: "offered" });
    expect(notifyClaimOffered).toHaveBeenCalledWith(expect.objectContaining({ beneficiaryUserId: "bob" }));
  });

  it("is 409 when the agent holds nothing on the issue", async () => {
    db.issueClaim.findFirst.mockResolvedValue(null);
    await expect(releaseClaim(agent, "p", "bug1")).rejects.toMatchObject({ status: 409 });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
  });

  it("only lets the holding agent release (the lookup is by its own agent id)", async () => {
    db.issueClaim.findFirst.mockResolvedValue(null);
    await releaseClaim(agent, "p", "bug1").catch(() => undefined);
    expect(db.issueClaim.findFirst.mock.calls[0][0].where).toMatchObject({ bugId: "bug1", agentId: "agent-ada", releasedAt: null });
  });

  it("is 404 for an issue outside the agent's project", async () => {
    db.$queryRaw.mockResolvedValue([]);
    await expect(releaseClaim(agent, "p", "bug1")).rejects.toMatchObject({ status: 404 });
  });
});

describe("release accepts the readable issue number (#605)", () => {
  it.each(["42", "ZE-42"])("resolves %s inside the agent's tenant and releases that issue", async (ref) => {
    db.bug.findFirst.mockResolvedValue({ id: "bug1", number: 42 });
    db.issueClaim.findFirst.mockResolvedValue(claim("offered"));
    db.bug.findFirstOrThrow.mockResolvedValue({ id: "bug1", title: "T", status: "open", assigneeId: null, projectId: "p" });

    const result = await releaseClaim(agent, "p", ref);

    expect(db.bug.findFirst.mock.calls[0][0].where).toEqual({ number: 42, tenantId: "tenant" });
    expect(db.issueClaim.findFirst.mock.calls[0][0].where).toMatchObject({ bugId: "bug1", agentId: "agent-ada" });
    expect(result).toMatchObject({ claimId: "claim-1", issueId: "bug1", reason: "declined" });
  });

  it("is 404 when no issue in the tenant has that number", async () => {
    db.bug.findFirst.mockResolvedValue(null);
    await expect(releaseClaim(agent, "p", "999")).rejects.toMatchObject({ status: 404 });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.issueClaim.update).not.toHaveBeenCalled();
  });

  it("still checks the project for a number from another project in the tenant", async () => {
    db.bug.findFirst.mockResolvedValue({ id: "bugother", number: 7 });
    db.$queryRaw.mockResolvedValue([]);
    await expect(releaseClaim(agent, "p", "7")).rejects.toMatchObject({ status: 404 });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
  });

  it("keeps the id lookup unchanged for an internal id", async () => {
    db.issueClaim.findFirst.mockResolvedValue(null);
    await releaseClaim(agent, "p", "bug1").catch(() => undefined);
    expect(db.bug.findFirst).not.toHaveBeenCalled();
  });
});
