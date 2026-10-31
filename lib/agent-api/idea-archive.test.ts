import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/agents/require-agent";

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  idea: { update: vi.fn(), findFirst: vi.fn() },
  bug: { findFirst: vi.fn() },
  ideaVerdict: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
  pointEntry: { createMany: vi.fn() },
  projectWorkflow: { findUnique: vi.fn() },
}));
const publish = vi.hoisted(() => vi.fn());
const audit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/events", () => ({ publish }));
vi.mock("@/lib/agents/audit", () => ({ audit }));

import { archiveIdea, giveIdeaVerdict } from "./idea-verdicts";
import { archiveIdeaSchema, archiveReasonLabel, duplicateRef } from "@/lib/idea-archive";

/** The locked idea row: filed by Ada. */
const idea = (overrides: Record<string, unknown> = {}) => ({
  id: "i1", number: 7, tenantId: "t1", projectId: "p1", status: "open", score: 1,
  reporterId: "ada", beneficiaryUserId: "ada", createdByOwnerId: "ada",
  ...overrides,
});

const manager = (level: AgentContext["level"] = "manager", ownerId = "dana"): AgentContext => ({
  agentId: `agent-${ownerId}`, name: ownerId, ownerId, tenantId: "t1", level, burst: false, keyId: "k1",
});

const implemented = { reason: "already_implemented" as const, evidence: "Shipped in emerjent/ziki#601 on 2026-10-20." };

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((run: (tx: unknown) => unknown) => run(db));
  db.$queryRaw.mockResolvedValue([idea()]);
  db.idea.findFirst.mockResolvedValue({ id: "i2" });
  db.bug.findFirst.mockResolvedValue({ id: "b615" });
  db.projectWorkflow.findUnique.mockResolvedValue(null);
});

describe("the archive body (#idea-archive)", () => {
  it("takes the three reasons, each with evidence", () => {
    for (const reason of ["already_implemented", "wrong_project"] as const) {
      expect(archiveIdeaSchema.safeParse({ reason, evidence: "Why." }).success).toBe(true);
    }
    expect(archiveIdeaSchema.safeParse({ reason: "duplicate", evidence: "Same bug.", duplicateOfIssue: 615 }).success).toBe(true);
    expect(archiveIdeaSchema.safeParse({ reason: "obsolete", evidence: "Why." }).success).toBe(false);
    expect(archiveIdeaSchema.safeParse({ reason: "wrong_project" }).success).toBe(false);
    expect(archiveIdeaSchema.safeParse({ reason: "wrong_project", evidence: "  " }).success).toBe(false);
  });

  it("makes a duplicate name exactly one idea or issue, and nothing else name one", () => {
    expect(archiveIdeaSchema.safeParse({ reason: "duplicate", evidence: "Same." }).success).toBe(false);
    expect(archiveIdeaSchema.safeParse({ reason: "duplicate", evidence: "Same.", duplicateOfIdea: 3, duplicateOfIssue: 4 }).success).toBe(false);
    expect(archiveIdeaSchema.safeParse({ reason: "wrong_project", evidence: "Why.", duplicateOfIdea: 3 }).success).toBe(false);
  });

  it("words the reason for the lists", () => {
    expect(archiveReasonLabel("already_implemented")).toBe("Already implemented");
    expect(archiveReasonLabel("wrong_project")).toBe("Wrong project");
    expect(archiveReasonLabel("duplicate", duplicateRef({ duplicateOfIdea: 12 }))).toBe("Duplicate of idea #12");
    expect(archiveReasonLabel("duplicate", duplicateRef({ duplicateOfIssue: 34 }))).toBe("Duplicate of issue #34");
    expect(archiveReasonLabel("duplicate", null)).toBe("Duplicate");
  });
});

describe("archiveIdea (#idea-archive)", () => {
  it("archives an open idea whatever its votes, with the reason, evidence, time and agent, and pays nothing", async () => {
    const result = await archiveIdea(manager(), "p1", "7", implemented);
    expect(result).toMatchObject({ ideaId: "i1", ideaNumber: 7, status: "archived", reason: "already_implemented", duplicateOf: null });
    expect(db.idea.update).toHaveBeenCalledWith({
      where: { id: "i1" },
      data: {
        status: "archived",
        archiveReason: "already_implemented",
        archiveEvidence: implemented.evidence,
        archiveDuplicateOf: null,
        archivedAt: expect.any(Date),
        archivedByAgentId: "agent-dana",
      },
    });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "idea.archived",
      projectId: "p1",
      payload: expect.objectContaining({ ideaId: "i1", ideaNumber: 7, reason: "already_implemented" }),
    }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-dana" }), "idea.archived", "idea:i1", expect.objectContaining({ reason: "already_implemented", evidence: implemented.evidence }));
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
    // No vote count was needed.
    expect(db.ideaVerdict.findMany).not.toHaveBeenCalled();
  });

  it("records what a duplicate duplicates, once it exists", async () => {
    const result = await archiveIdea(manager(), "p1", "7", { reason: "duplicate", evidence: "Same redirect bug.", duplicateOfIssue: 615 });
    expect(result.duplicateOf).toBe("issue:615");
    expect(db.bug.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "t1", number: 615 }) }));
    expect(db.idea.update.mock.calls[0][0].data).toMatchObject({ archiveReason: "duplicate", archiveDuplicateOf: "issue:615" });

    vi.clearAllMocks();
    db.$transaction.mockImplementation((run: (tx: unknown) => unknown) => run(db));
    db.$queryRaw.mockResolvedValue([idea()]);
    db.idea.findFirst.mockResolvedValue({ id: "i2" });
    const ofIdea = await archiveIdea(manager(), "p1", "7", { reason: "duplicate", evidence: "Same.", duplicateOfIdea: 2 });
    expect(ofIdea.duplicateOf).toBe("idea:2");
    // Never itself.
    expect(db.idea.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ number: 2, NOT: { id: "i1" } }) }));
  });

  it("refuses a duplicate of something that doesn't exist (422 duplicate_not_found)", async () => {
    db.bug.findFirst.mockResolvedValue(null);
    await expect(archiveIdea(manager(), "p1", "7", { reason: "duplicate", evidence: "Same.", duplicateOfIssue: 999 }))
      .rejects.toMatchObject({ status: 422, body: { error: "duplicate_not_found" } });
    db.idea.findFirst.mockResolvedValue(null);
    await expect(archiveIdea(manager(), "p1", "7", { reason: "duplicate", evidence: "Same.", duplicateOfIdea: 7 }))
      .rejects.toMatchObject({ status: 422, body: { error: "duplicate_not_found" } });
    expect(db.idea.update).not.toHaveBeenCalled();
  });

  it("refuses a manager whose owner owns the idea (403 not_independent)", async () => {
    for (const row of [idea({ reporterId: "dana" }), idea({ beneficiaryUserId: "dana" }), idea({ createdByOwnerId: "dana" })]) {
      db.$queryRaw.mockResolvedValue([row]);
      await expect(archiveIdea(manager(), "p1", "7", implemented)).rejects.toMatchObject({ status: 403, body: { error: "not_independent" } });
    }
    expect(db.idea.update).not.toHaveBeenCalled();
  });

  it("refuses a working agent", async () => {
    await expect(archiveIdea(manager("working"), "p1", "7", implemented)).rejects.toMatchObject({ name: "AgentLevelError", required: "manager" });
    expect(db.idea.update).not.toHaveBeenCalled();
  });

  it.each([
    ["converted", "idea_converted"],
    ["rejected", "idea_rejected"],
    ["archived", "idea_archived"],
  ])("refuses an idea that is %s (409 %s)", async (status, error) => {
    db.$queryRaw.mockResolvedValue([idea({ status })]);
    await expect(archiveIdea(manager(), "p1", "7", implemented)).rejects.toMatchObject({ status: 409, body: { error } });
    expect(db.idea.update).not.toHaveBeenCalled();
  });

  it("takes no more verdicts once archived", async () => {
    db.$queryRaw.mockResolvedValue([idea({ status: "archived" })]);
    await expect(
      giveIdeaVerdict({ tenantId: "t1", userId: "bob" }, "p1", "7", { opinion: "good", summary: "Useful.", description: "Saves a click." }),
    ).rejects.toMatchObject({ status: 409, body: { error: "idea_archived" } });
  });
});
