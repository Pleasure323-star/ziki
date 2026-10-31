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

import { archiveIdea, giveIdeaVerdict, withdrawIdea } from "./idea-verdicts";
import { archiveIdeaSchema, archiveReasonLabel, duplicateRef, withdrawIdeaSchema } from "@/lib/idea-archive";

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

describe("the archive route refuses the reason withdrawn (#idea-withdraw)", () => {
  it("does not parse withdrawn, and names the withdraw route", () => {
    const parsed = archiveIdeaSchema.safeParse({ reason: "withdrawn", evidence: "The owner says so." });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({ path: ["reason"], message: expect.stringContaining("/withdraw") });
  });

  it("refuses withdrawn in the archive core too, before touching the idea", async () => {
    await expect(archiveIdea(manager(), "p1", "7", { reason: "withdrawn", evidence: "Owner says so." }))
      .rejects.toMatchObject({ status: 422, body: { error: "invalid_reason" } });
    expect(db.idea.update).not.toHaveBeenCalled();
  });
});

describe("withdrawIdea (#idea-withdraw)", () => {
  const ada = { tenantId: "t1", userId: "ada", agentId: "agent-ada" };

  it("lets the idea's owner withdraw it: archived as withdrawn, audited, with the event, and no points", async () => {
    const result = await withdrawIdea(ada, "p1", "7", { evidence: "The new search page replaced it." });
    expect(result).toMatchObject({ ideaId: "i1", ideaNumber: 7, status: "archived", reason: "withdrawn", evidence: "The new search page replaced it." });
    expect(db.idea.update).toHaveBeenCalledWith({
      where: { id: "i1" },
      data: {
        status: "archived",
        archiveReason: "withdrawn",
        archiveEvidence: "The new search page replaced it.",
        archiveDuplicateOf: null,
        archivedAt: expect.any(Date),
        archivedByAgentId: "agent-ada",
      },
    });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "idea.archived",
      payload: expect.objectContaining({ ideaId: "i1", reason: "withdrawn", withdrawnByUserId: "ada" }),
    }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-ada" }), "idea.archived", "idea:i1", expect.objectContaining({ reason: "withdrawn" }));
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("lets the person it is for withdraw it too, from the web with no evidence and no agent audit row", async () => {
    db.$queryRaw.mockResolvedValue([idea({ reporterId: "bob-agent-owner", beneficiaryUserId: "ada", createdByOwnerId: "bob-agent-owner" })]);
    const result = await withdrawIdea({ tenantId: "t1", userId: "ada", agentId: null }, "p1", "7");
    expect(result).toMatchObject({ status: "archived", reason: "withdrawn", evidence: null });
    expect(db.idea.update.mock.calls[0][0].data).toMatchObject({ archiveEvidence: null, archivedByAgentId: null });
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses anyone who does not own the idea (403 not_idea_owner), whatever their agent's level", async () => {
    await expect(withdrawIdea({ tenantId: "t1", userId: "dana", agentId: "agent-dana" }, "p1", "7"))
      .rejects.toMatchObject({ status: 403, body: { error: "not_idea_owner" } });
    expect(db.idea.update).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["converted", "rejected", "archived"])("refuses an idea that is %s (409 idea_not_open)", async (status) => {
    db.$queryRaw.mockResolvedValue([idea({ status })]);
    await expect(withdrawIdea(ada, "p1", "7")).rejects.toMatchObject({ status: 409, body: { error: "idea_not_open" } });
    expect(db.idea.update).not.toHaveBeenCalled();
  });

  it("takes optional evidence only, and labels the reason for the lists", () => {
    expect(withdrawIdeaSchema.safeParse({}).success).toBe(true);
    expect(withdrawIdeaSchema.safeParse({ evidence: "Obsolete." }).success).toBe(true);
    expect(withdrawIdeaSchema.safeParse({ reason: "duplicate" }).success).toBe(false);
    expect(archiveReasonLabel("withdrawn")).toBe("Withdrawn by its owner");
  });
});
