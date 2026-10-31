import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const mock = {
    bug: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    bugActivity: { create: vi.fn() },
    closeSuggestion: { findUnique: vi.fn(), upsert: vi.fn(), aggregate: vi.fn(), deleteMany: vi.fn() },
    issueClaim: { findMany: vi.fn(), updateMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  mock.$transaction.mockImplementation((fn: (tx: typeof mock) => unknown) => fn(mock));
  return mock;
});
const confirmed = vi.hoisted(() => ({ isConfirmed: vi.fn() }));
const duplicates = vi.hoisted(() => {
  class DuplicateLinkRefused extends Error {}
  return { DuplicateLinkRefused, linkDuplicate: vi.fn() };
});
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/events", () => ({ publish: vi.fn(async () => ({ id: "evt" })) }));
vi.mock("@/lib/agents/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-api/confirmations", () => confirmed);
vi.mock("@/lib/duplicate-link", () => duplicates);

import { publish } from "@/lib/agent-api/events";
import {
  closeIssue,
  closeIssueSchema,
  closeSuggestionSchema,
  reopenIssue,
  suggestClose,
  withdrawIssue,
} from "./close-suggestions";

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
const input = { reason: "superseded" as const, summary: "Issue #3 already covers this.", evidence: "#3 shipped the same export fix." };
const closeInput = { reason: "superseded" as const, evidence: "#3 shipped the same export fix." };

/** The locked issue row, as the close core reads it. */
function row(extra: Record<string, unknown> = {}) {
  return {
    status: "open", substatus: "open", isDeleted: false, isBoosted: false, closeReason: null,
    reporterId: "ada", beneficiaryUserId: null, assigneeId: null, createdByAgent: null,
    ...extra,
  };
}

function tally(votes: number) {
  db.closeSuggestion.aggregate.mockResolvedValue({ _sum: { votes } });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  db.$queryRaw.mockResolvedValue([{ id: "issue1" }]);
  db.bug.findFirst.mockResolvedValue({ id: "issue1", number: 7 });
  db.bug.findUnique.mockResolvedValue(row());
  db.issueClaim.findMany.mockResolvedValue([]);
  db.closeSuggestion.findUnique.mockResolvedValue(null);
  db.closeSuggestion.deleteMany.mockResolvedValue({ count: 2 });
  confirmed.isConfirmed.mockResolvedValue(true);
  duplicates.linkDuplicate.mockResolvedValue({ previous: null, unchanged: false, target: { id: "issue2", number: 2 } });
  tally(1);
});

describe("close schemas (#close-reasons)", () => {
  it("takes a voted reason, the evidence and a summary, with an optional description", () => {
    expect(closeSuggestionSchema.parse(input)).toEqual(input);
    for (const reason of ["not_reproducible", "already_implemented", "not_planned"]) {
      expect(closeSuggestionSchema.safeParse({ ...input, reason }).success).toBe(true);
    }
    expect(closeSuggestionSchema.safeParse({ ...input, reason: "withdrawn" }).success).toBe(false);
    expect(closeSuggestionSchema.safeParse({ ...input, reason: "wontfix" }).success).toBe(false);
    expect(closeSuggestionSchema.safeParse({ reason: "superseded", summary: "x." }).success).toBe(false);
    expect(closeSuggestionSchema.safeParse({ ...input, evidence: " " }).success).toBe(false);
  });

  it("requires duplicateOf for a duplicate, and only for a duplicate", () => {
    expect(closeSuggestionSchema.safeParse({ ...input, reason: "duplicate" }).success).toBe(false);
    expect(closeSuggestionSchema.safeParse({ ...input, reason: "duplicate", duplicateOf: 2 }).success).toBe(true);
    expect(closeSuggestionSchema.safeParse({ ...input, reason: "duplicate", duplicateOf: "#2" }).success).toBe(true);
    expect(closeSuggestionSchema.safeParse({ ...input, duplicateOf: 2 }).success).toBe(false);
    expect(closeIssueSchema.safeParse({ reason: "duplicate", evidence: "x" }).success).toBe(false);
    expect(closeIssueSchema.safeParse({ reason: "duplicate", evidence: "x", duplicateOf: 2 }).success).toBe(true);
  });

  it("closes with the evidence, not a summary, and never as withdrawn", () => {
    expect(closeIssueSchema.parse(closeInput)).toEqual(closeInput);
    expect(closeIssueSchema.safeParse({ ...closeInput, summary: "x" }).success).toBe(false);
    expect(closeIssueSchema.safeParse({ reason: "superseded" }).success).toBe(false);
    expect(closeIssueSchema.safeParse({ ...closeInput, reason: "withdrawn" }).success).toBe(false);
  });
});

describe("suggestClose (#close-reasons)", () => {
  it("records a working agent's suggestion with 1 vote and its evidence, not yet queued", async () => {
    await expect(suggestClose(bob, "project", "7", input)).resolves.toEqual({
      issueId: "issue1", issueNumber: 7, reason: "superseded", votes: 1, threshold: 3, queued: false, closed: false, releasedClaimIds: [],
    });
    expect(db.closeSuggestion.upsert).toHaveBeenCalledWith({
      where: { bugId_onBehalfOfUserId: { bugId: "issue1", onBehalfOfUserId: "bob" } },
      update: expect.objectContaining({ reason: "superseded", votes: 1, summary: input.summary, description: null, evidence: input.evidence, duplicateOfId: null, agentId: "bob-agent" }),
      create: expect.objectContaining({ bugId: "issue1", onBehalfOfUserId: "bob", votes: 1 }),
    });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "issue.close_suggested",
      payload: expect.objectContaining({ issueId: "issue1", reason: "superseded", evidence: input.evidence, votes: 1, threshold: 3 }),
    }));
  });

  it("tallies the suggestion's own reason only", async () => {
    await suggestClose(bob, "project", "7", { ...input, reason: "not_reproducible" });
    expect(db.closeSuggestion.aggregate).toHaveBeenCalledWith({ where: { bugId: "issue1", reason: "not_reproducible" }, _sum: { votes: true } });
  });

  it("counts a manager agent's suggestion as 3 votes, and queues the issue at the threshold", async () => {
    tally(5);
    await expect(suggestClose(dana, "project", "7", input)).resolves.toMatchObject({ votes: 5, queued: true });
    expect(db.closeSuggestion.upsert.mock.calls[0][0].create).toMatchObject({ votes: 3, onBehalfOfUserId: "dana" });
  });

  it("keeps a person's highest weight when another of their agents suggests again", async () => {
    db.closeSuggestion.findUnique.mockResolvedValue({ votes: 3 });
    await suggestClose(bob, "project", "7", input);
    expect(db.closeSuggestion.upsert.mock.calls[0][0].update).toMatchObject({ votes: 3 });
  });

  it("records the other issue on a duplicate suggestion", async () => {
    db.bug.findFirst
      .mockResolvedValueOnce({ id: "issue1", number: 7 })
      .mockResolvedValueOnce({ id: "issue1", number: 7 })
      .mockResolvedValueOnce({ id: "issue2", number: 2 })
      .mockResolvedValueOnce({ id: "issue2" });
    await suggestClose(bob, "project", "7", { ...input, reason: "duplicate", duplicateOf: 2 });
    expect(db.closeSuggestion.upsert.mock.calls[0][0].create).toMatchObject({ reason: "duplicate", duplicateOfId: "issue2" });
  });

  it("refuses a duplicate of itself with 422 invalid_duplicate", async () => {
    await expect(suggestClose(bob, "project", "7", { ...input, reason: "duplicate", duplicateOf: 7 })).rejects.toMatchObject({
      status: 422,
      body: expect.objectContaining({ error: "invalid_duplicate" }),
    });
    expect(db.closeSuggestion.upsert).not.toHaveBeenCalled();
  });

  it("refuses a closed or live issue with 409 already_closed", async () => {
    for (const status of ["closed", "resolved"]) {
      db.bug.findUnique.mockResolvedValue(row({ status }));
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

describe("closeIssue (#close-reasons)", () => {
  it("requires a manager agent", async () => {
    await expect(closeIssue(bob, "project", "7", closeInput)).rejects.toThrow("This needs a manager agent.");
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("refuses below that reason's threshold with 409 below_threshold", async () => {
    tally(2);
    await expect(closeIssue(dana, "project", "7", { reason: "not_planned", evidence: "Declined: out of scope for v2." })).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ error: "below_threshold", reason: "not_planned", votes: 2, threshold: 3 }),
    });
    expect(db.closeSuggestion.aggregate).toHaveBeenCalledWith({ where: { bugId: "issue1", reason: "not_planned" }, _sum: { votes: true } });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("closes the issue with its reason and evidence, releases live claims and publishes issue.closed", async () => {
    tally(5);
    db.bug.findUnique.mockResolvedValue(row({ status: "in_progress", substatus: "in_progress", isBoosted: true }));
    db.issueClaim.findMany.mockResolvedValue([{ id: "claim1", agentId: "cara-agent", beneficiaryUserId: "cara" }]);
    const evidence = "Ran it 3 times on main (requests r1, r2, r3): all fine.";
    await expect(closeIssue(dana, "project", "7", { reason: "not_reproducible", evidence })).resolves.toEqual({
      issueId: "issue1", issueNumber: 7, status: "closed", substatus: "closed", closeReason: "not_reproducible", closeEvidence: evidence, duplicateOfId: null,
      votes: 5, threshold: 3, releasedClaimIds: ["claim1"],
    });
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "issue1" },
      data: { status: "closed", substatus: "closed", closeReason: "not_reproducible", closeEvidence: evidence, closedAt: expect.any(Date), isBoosted: false, boostedAt: null },
    });
    expect(db.issueClaim.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["claim1"] } },
      data: expect.objectContaining({ status: "released", releaseReason: "closed" }),
    });
    expect(db.bugActivity.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      type: "status_changed",
      metadata: expect.objectContaining({ from: "in_progress", to: "closed", via: "not_reproducible", evidence }),
    }) });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "claim.released", payload: expect.objectContaining({ claimId: "claim1", reason: "closed" }) }));
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "issue.closed",
      payload: expect.objectContaining({ issueId: "issue1", from: "in_progress", reason: "not_reproducible", evidence, votes: 5 }),
    }));
    expect(duplicates.linkDuplicate).not.toHaveBeenCalled();
  });

  it("marks a duplicate through the one duplicate rule", async () => {
    tally(3);
    db.bug.findFirst
      .mockResolvedValueOnce({ id: "issue1", number: 7 })
      .mockResolvedValueOnce({ id: "issue1", number: 7 })
      .mockResolvedValueOnce({ id: "issue2", number: 2 })
      .mockResolvedValueOnce({ id: "issue2" });
    await expect(closeIssue(dana, "project", "7", { reason: "duplicate", evidence: "#2 owns the export fix.", duplicateOf: 2 })).resolves.toMatchObject({
      closeReason: "duplicate", duplicateOfId: "issue2",
    });
    expect(duplicates.linkDuplicate).toHaveBeenCalledWith(db, { tenantId: "tenant", bugId: "issue1", targetId: "issue2", actorId: "dana" });
  });

  it("refuses a duplicate link that breaks the one-level rule with 409 duplicate_refused", async () => {
    tally(3);
    db.bug.findFirst
      .mockResolvedValueOnce({ id: "issue1", number: 7 })
      .mockResolvedValueOnce({ id: "issue1", number: 7 })
      .mockResolvedValueOnce({ id: "issue2", number: 2 })
      .mockResolvedValueOnce({ id: "issue2" });
    duplicates.linkDuplicate.mockRejectedValue(new duplicates.DuplicateLinkRefused("#2 is itself a duplicate."));
    await expect(closeIssue(dana, "project", "7", { reason: "duplicate", evidence: "#2 owns it.", duplicateOf: 2 })).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ error: "duplicate_refused" }),
    });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("refuses an issue that is already closed", async () => {
    tally(5);
    db.bug.findUnique.mockResolvedValue(row({ status: "closed", substatus: "closed" }));
    await expect(closeIssue(dana, "project", "7", closeInput)).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ error: "already_closed" }),
    });
    expect(db.bug.update).not.toHaveBeenCalled();
  });
});

describe("reopenIssue (#close-reasons)", () => {
  const fresh = { evidence: "Fails again on main: request id req_9f2." };

  it("reopens an issue closed as not reproducible to Open when it had been confirmed", async () => {
    db.bug.findUnique.mockResolvedValue(row({ status: "closed", substatus: "closed", closeReason: "not_reproducible" }));
    await expect(reopenIssue(dana, "project", "7", fresh)).resolves.toEqual({
      issueId: "issue1", issueNumber: 7, status: "open", substatus: "open", previousReason: "not_reproducible", evidence: fresh.evidence, clearedSuggestions: 2,
    });
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "issue1" },
      data: { status: "open", substatus: "open", closeReason: null, closeEvidence: null, closedAt: null },
    });
    expect(db.closeSuggestion.deleteMany).toHaveBeenCalledWith({ where: { bugId: "issue1", reason: "not_reproducible" } });
    expect(db.bugActivity.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      type: "status_changed",
      metadata: expect.objectContaining({ from: "closed", to: "open", via: "reopened", evidence: fresh.evidence }),
    }) });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "issue.reopened", payload: expect.objectContaining({ to: "open", evidence: fresh.evidence }) }));
  });

  it("reopens to Requires confirmation when it had not been confirmed", async () => {
    db.bug.findUnique.mockResolvedValue(row({ status: "closed", substatus: "closed", closeReason: "not_reproducible" }));
    confirmed.isConfirmed.mockResolvedValue(false);
    await expect(reopenIssue(dana, "project", "7", fresh)).resolves.toMatchObject({ status: "open", substatus: "requires_confirmation" });
  });

  it("refuses any other close with 409 not_reopenable", async () => {
    for (const closeReason of ["superseded", "already_implemented", "duplicate", "not_planned", "withdrawn"]) {
      db.bug.findUnique.mockResolvedValue(row({ status: "closed", substatus: "closed", closeReason }));
      await expect(reopenIssue(dana, "project", "7", fresh)).rejects.toMatchObject({ status: 409, body: expect.objectContaining({ error: "not_reopenable" }) });
    }
    db.bug.findUnique.mockResolvedValue(row({ status: "open", substatus: "open" }));
    await expect(reopenIssue(dana, "project", "7", fresh)).rejects.toMatchObject({ status: 409 });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("needs a manager agent independent of the issue", async () => {
    db.bug.findUnique.mockResolvedValue(row({ status: "closed", substatus: "closed", closeReason: "not_reproducible", reporterId: "dana" }));
    await expect(reopenIssue(dana, "project", "7", fresh)).rejects.toMatchObject({ status: 403, body: expect.objectContaining({ error: "not_independent" }) });
    await expect(reopenIssue(bob, "project", "7", fresh)).rejects.toThrow("This needs a manager agent.");
    expect(db.bug.update).not.toHaveBeenCalled();
  });
});

describe("withdrawIssue (#close-reasons)", () => {
  const ada = { tenantId: "tenant", userId: "ada", agentId: "ada-agent", agentName: "Ada's Claude" };

  it("closes the owner's issue as withdrawn at once, without votes", async () => {
    db.issueClaim.findMany.mockResolvedValue([{ id: "offer1", agentId: "bob-agent", beneficiaryUserId: "bob" }]);
    await expect(withdrawIssue(ada, "project", "7", { evidence: "Not needed any more." })).resolves.toMatchObject({
      issueId: "issue1", status: "closed", substatus: "closed", closeReason: "withdrawn", closeEvidence: "Not needed any more.", releasedClaimIds: ["offer1"],
    });
    expect(db.closeSuggestion.aggregate).not.toHaveBeenCalled();
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "issue1" },
      data: expect.objectContaining({ status: "closed", substatus: "closed", closeReason: "withdrawn", closeEvidence: "Not needed any more." }),
    });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "issue.closed",
      payload: expect.objectContaining({ reason: "withdrawn", withdrawnByUserId: "ada" }),
    }));
  });

  it("lets the person it is for withdraw it, with no evidence", async () => {
    db.bug.findUnique.mockResolvedValue(row({ beneficiaryUserId: "cara" }));
    await expect(withdrawIssue({ ...ada, userId: "cara", agentId: null, agentName: null }, "project", "7")).resolves.toMatchObject({ closeEvidence: null });
  });

  it("refuses anyone else with 403 not_issue_owner", async () => {
    await expect(withdrawIssue({ ...ada, userId: "bob" }, "project", "7")).rejects.toMatchObject({
      status: 403,
      body: expect.objectContaining({ error: "not_issue_owner" }),
    });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("refuses a closed or live issue with 409 already_closed", async () => {
    db.bug.findUnique.mockResolvedValue(row({ status: "resolved", substatus: "on_dev" }));
    await expect(withdrawIssue(ada, "project", "7")).rejects.toMatchObject({ status: 409, body: expect.objectContaining({ error: "already_closed" }) });
  });
});
