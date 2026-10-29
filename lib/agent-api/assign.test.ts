import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLevelError } from "@/lib/agents/levels";

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  bug: { findFirst: vi.fn() },
  agent: { findFirst: vi.fn() },
  issueClaim: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn(), count: vi.fn() },
}));
const isConfirmed = vi.hoisted(() => vi.fn());
const notifyClaimOffered = vi.hoisted(() => vi.fn());
const publish = vi.hoisted(() => vi.fn());
const acceptOffer = vi.hoisted(() => vi.fn());
const scheduleOfferExpiry = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/confirmations", () => ({ isConfirmed }));
vi.mock("@/lib/agent-notifications", () => ({ notifyClaimOffered }));
vi.mock("@/lib/agent-api/events", () => ({ publish }));
vi.mock("@/lib/redesigns", () => ({ assertRedesignOpen: vi.fn() }));
vi.mock("@/lib/approvals", () => ({ assertApprovalOpen: vi.fn() }));
vi.mock("@/lib/workflow", () => ({ workflowFor: vi.fn(async () => ({ offerWindowSeconds: 1800, maxActiveClaims: 2 })) }));
vi.mock("@/lib/agent-api/offer", () => ({
  acceptOffer,
  scheduleOfferExpiry,
  isOfferExpired: (offeredAt: Date | null, now = Date.now(), windowMs = 1_800_000) => !offeredAt || now - offeredAt.getTime() >= windowMs,
}));

import { assignIssue, assignSchema } from "./assign";

const manager = { agentId: "agent-mo", name: "Mo", ownerId: "mo", tenantId: "t1", level: "manager" as const, burst: false, keyId: "k" };
const input = (overrides: Record<string, unknown> = {}) => assignSchema.parse({ agentId: "agent-bob", ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  db.$queryRaw.mockResolvedValue([{ id: "bug-1" }]);
  db.$transaction.mockImplementation((run: (tx: unknown) => unknown) => run(db));
  db.bug.findFirst.mockResolvedValue({ id: "bug-1", title: "Example", status: "open", assigneeId: null, convertedToIssueAt: new Date() });
  db.agent.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => (
    { "agent-bob": { id: "agent-bob", ownerUserId: "bob" }, "agent-mo": { id: "agent-mo", ownerUserId: "mo" } } as Record<string, unknown>
  )[where.id] ?? null);
  db.issueClaim.findFirst.mockResolvedValue(null);
  db.issueClaim.count.mockResolvedValue(0);
  db.issueClaim.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "claim-1", ...data }));
  isConfirmed.mockResolvedValue(true);
  acceptOffer.mockResolvedValue({ claim: { id: "claim-1", status: "active" } });
});

describe("assignIssue (#715)", () => {
  it("offers a ready issue to the chosen agent and credits the manager's owner as dispatcher", async () => {
    const result = await assignIssue(manager, "p1", "bug-1", input());

    expect(result.mode).toBe("offer");
    expect(db.issueClaim.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      bugId: "bug-1", agentId: "agent-bob", beneficiaryUserId: "bob", status: "offered", dispatcherUserId: "mo",
    }) });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "claim.offered",
      payload: expect.objectContaining({ assignedByAgentId: "agent-mo", mode: "offer", beneficiaryUserId: "bob" }),
    }));
    expect(notifyClaimOffered).toHaveBeenCalled();
    expect(scheduleOfferExpiry).toHaveBeenCalledWith("claim-1");
    expect(acceptOffer).not.toHaveBeenCalled();
  });

  it("assigns to the manager itself with \"self\", with no dispatcher credit", async () => {
    await assignIssue(manager, "p1", "bug-1", input({ agentId: "self" }));

    const data = db.issueClaim.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ agentId: "agent-mo", beneficiaryUserId: "mo" });
    expect(data).not.toHaveProperty("dispatcherUserId");
  });

  it("starts the claim at once in direct mode, accepting as the target agent", async () => {
    const result = await assignIssue(manager, "p1", "bug-1", input({ mode: "direct" }));

    expect(result).toMatchObject({ mode: "direct", claim: { status: "active" } });
    expect(acceptOffer).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-bob", ownerId: "bob" }), "claim-1");
    expect(notifyClaimOffered).not.toHaveBeenCalled();
  });

  it("accepts as the manager itself for a direct self-assignment", async () => {
    await assignIssue(manager, "p1", "bug-1", input({ agentId: "self", mode: "direct" }));
    expect(acceptOffer).toHaveBeenCalledWith(manager, "claim-1");
  });

  it("needs a manager agent", async () => {
    await expect(assignIssue({ ...manager, level: "working" }, "p1", "bug-1", input())).rejects.toBeInstanceOf(AgentLevelError);
  });

  it.each([
    ["a closed issue", { status: "closed" }, "Only open issues"],
    ["an issue assigned to someone else", { assigneeId: "cara" }, "assigned to someone else"],
  ])("refuses %s", async (_label, bug, message) => {
    db.bug.findFirst.mockResolvedValue({ id: "bug-1", title: "Example", status: "open", assigneeId: null, convertedToIssueAt: new Date(), ...bug });
    await expect(assignIssue(manager, "p1", "bug-1", input())).rejects.toMatchObject({ status: 409, message: expect.stringContaining(message) });
    expect(db.issueClaim.create).not.toHaveBeenCalled();
  });

  it("refuses an unconfirmed issue", async () => {
    isConfirmed.mockResolvedValue(false);
    await expect(assignIssue(manager, "p1", "bug-1", input())).rejects.toMatchObject({ status: 409 });
  });

  it("refuses an unknown or revoked agent with 404", async () => {
    await expect(assignIssue(manager, "p1", "bug-1", input({ agentId: "agent-nobody" }))).rejects.toMatchObject({ status: 404 });
  });

  it("refuses when the issue has an active claim or a live offer", async () => {
    db.issueClaim.findFirst.mockResolvedValue({ id: "c0", status: "active", offeredAt: new Date() });
    await expect(assignIssue(manager, "p1", "bug-1", input())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("active claim") });
    db.issueClaim.findFirst.mockResolvedValue({ id: "c0", status: "offered", offeredAt: new Date() });
    await expect(assignIssue(manager, "p1", "bug-1", input())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("pending offer") });
  });

  it("releases an expired offer and assigns", async () => {
    db.issueClaim.findFirst.mockResolvedValue({ id: "c0", status: "offered", offeredAt: new Date(Date.now() - 3_600_000) });
    await assignIssue(manager, "p1", "bug-1", input());
    expect(db.issueClaim.update).toHaveBeenCalledWith({ where: { id: "c0" }, data: expect.objectContaining({ status: "released", releaseReason: "expired" }) });
    expect(db.issueClaim.create).toHaveBeenCalled();
  });

  it("refuses when the target's owner is at the active-claim limit", async () => {
    db.issueClaim.count.mockResolvedValue(2);
    await expect(assignIssue(manager, "p1", "bug-1", input())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("limit") });
  });

  it("defaults the mode to offer and rejects unknown fields", () => {
    expect(assignSchema.parse({ agentId: "self" }).mode).toBe("offer");
    expect(assignSchema.safeParse({ agentId: "self", extra: 1 }).success).toBe(false);
  });
});
