import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const mock = {
    bug: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    bugActivity: { create: vi.fn() },
    closeSuggestion: { upsert: vi.fn(), aggregate: vi.fn() },
    issueClaim: { findMany: vi.fn(), updateMany: vi.fn() },
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
import { closeIssueAsSuperseded, closeIssueSchema, closeSuggestionSchema, suggestClose } from "./close-suggestions";

const bob = {
  agentId: "bob-agent",
  name: "Bob's Claude",
  ownerId: "bob",
  tenantId: "tenant",
  level: "working" as const,
  burst: false,
  keyId: "key1",
};
const dana = { ...bob, agentId: "dana-agent", name: "Dana's Claude", ownerId: "dana", level: "manager" as const };
const input = { reason: "superseded" as const, summary: "Issue #3 already covers this." };

function tally(votes: number) {
  db.closeSuggestion.aggregate.mockResolvedValue({ _sum: { votes } });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  db.$queryRaw.mockResolvedValue([{ id: "issue1" }]);
  db.bug.findFirst.mockResolvedValue({ id: "issue1", number: 7 });
  db.bug.findUnique.mockResolvedValue({ status: "open", isDeleted: false, isBoosted: false });
  db.issueClaim.findMany.mockResolvedValue([]);
  tally(1);
});

describe("close suggestion schemas", () => {
  it("takes a known reason and a summary, with an optional description", () => {
    expect(closeSuggestionSchema.parse(input)).toEqual(input);
    expect(closeSuggestionSchema.safeParse({ ...input, reason: "duplicate" }).success).toBe(false);
    expect(closeSuggestionSchema.safeParse({ reason: "superseded" }).success).toBe(false);
    expect(closeIssueSchema.safeParse({ ...input, description: "x" }).success).toBe(false);
  });
});

describe("suggestClose (#close-superseded)", () => {
  it("records a working agent's suggestion with 1 vote, not yet queued", async () => {
    await expect(suggestClose(bob, "project", "7", input)).resolves.toEqual({
      issueId: "issue1", issueNumber: 7, reason: "superseded", votes: 1, threshold: 3, queued: false,
    });
    expect(db.closeSuggestion.upsert).toHaveBeenCalledWith({
      where: { bugId_onBehalfOfUserId: { bugId: "issue1", onBehalfOfUserId: "bob" } },
      update: expect.objectContaining({ reason: "superseded", votes: 1, summary: input.summary, description: null, agentId: "bob-agent" }),
      create: expect.objectContaining({ bugId: "issue1", onBehalfOfUserId: "bob", votes: 1 }),
    });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "issue.close_suggested",
      payload: expect.objectContaining({ issueId: "issue1", reason: "superseded", votes: 1, threshold: 3 }),
    }));
  });

  it("counts a manager agent's suggestion as 3 votes, and queues the issue at the threshold", async () => {
    tally(5);
    await expect(suggestClose(dana, "project", "7", input)).resolves.toMatchObject({ votes: 5, queued: true });
    expect(db.closeSuggestion.upsert.mock.calls[0][0].create).toMatchObject({ votes: 3, onBehalfOfUserId: "dana" });
  });

  it("refuses a closed or live issue with 409 already_closed", async () => {
    for (const status of ["closed", "resolved"]) {
      db.bug.findUnique.mockResolvedValue({ status, isDeleted: false, isBoosted: false });
      await expect(suggestClose(bob, "project", "7", input)).rejects.toMatchObject({
        status: 409,
        body: expect.objectContaining({ error: "already_closed" }),
      });
    }
    expect(db.closeSuggestion.upsert).not.toHaveBeenCalled();
  });

  it("answers 404 for an issue outside the project", async () => {
    db.bug.findFirst.mockResolvedValue(null);
    await expect(suggestClose(bob, "project", "7", input)).rejects.toMatchObject({ status: 404 });
  });
});

describe("closeIssueAsSuperseded (#close-superseded)", () => {
  it("requires a manager agent", async () => {
    await expect(closeIssueAsSuperseded(bob, "project", "7", input)).rejects.toThrow("This needs a manager agent.");
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("refuses below the threshold with 409 below_threshold", async () => {
    tally(2);
    await expect(closeIssueAsSuperseded(dana, "project", "7", input)).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ error: "below_threshold", votes: 2, threshold: 3 }),
    });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("closes the issue as superseded, releases live claims and publishes issue.closed", async () => {
    tally(5);
    db.bug.findUnique.mockResolvedValue({ status: "in_progress", isDeleted: false, isBoosted: true });
    db.issueClaim.findMany.mockResolvedValue([{ id: "claim1", agentId: "cara-agent", beneficiaryUserId: "cara" }]);
    await expect(closeIssueAsSuperseded(dana, "project", "7", input)).resolves.toEqual({
      issueId: "issue1", issueNumber: 7, status: "closed", closeReason: "superseded", votes: 5, threshold: 3, releasedClaimIds: ["claim1"],
    });
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "issue1" },
      data: { status: "closed", closeReason: "superseded", isBoosted: false, boostedAt: null },
    });
    expect(db.issueClaim.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["claim1"] } },
      data: expect.objectContaining({ status: "released", releaseReason: "closed" }),
    });
    expect(db.bugActivity.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      type: "status_changed",
      metadata: expect.objectContaining({ from: "in_progress", to: "closed", via: "superseded", note: input.summary }),
    }) });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "claim.released", payload: expect.objectContaining({ claimId: "claim1", reason: "closed" }) }));
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "issue.closed",
      payload: expect.objectContaining({ issueId: "issue1", from: "in_progress", reason: "superseded", votes: 5 }),
    }));
  });

  it("refuses an issue that is already closed", async () => {
    tally(5);
    db.bug.findUnique.mockResolvedValue({ status: "closed", isDeleted: false, isBoosted: false });
    await expect(closeIssueAsSuperseded(dana, "project", "7", input)).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ error: "already_closed" }),
    });
    expect(db.bug.update).not.toHaveBeenCalled();
  });
});
