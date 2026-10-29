import { Prisma, type AgentLevel } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIRMATION_REVIEWER_POINTS, reviewerPointsAt } from "@/lib/points/rules";

type Row = {
  id: string;
  bugId: string;
  agentId: string;
  kind: string;
  verdict: string;
  severity: string | null;
  duplicateOfId: string | null;
  onBehalfOfUserId: string;
  createdAt?: Date;
};

const state = vi.hoisted(() => ({
  validations: [] as Row[],
  agents: {} as Record<string, { id: string; ownerUserId: string; level?: string }>,
}));
const notifications = vi.hoisted(() => ({ notifyClaimOffered: vi.fn() }));

const db = vi.hoisted(() => ({
  bug: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  bugActivity: { create: vi.fn() },
  bugRevision: { findFirst: vi.fn() },
  membership: { findMany: vi.fn(), findUnique: vi.fn() },
  issueValidation: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn(), count: vi.fn() },
  issueClaim: { findFirst: vi.fn(), groupBy: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  redesignProposal: { count: vi.fn() },
  pointEntry: { createMany: vi.fn() },
  agentAuditEvent: { create: vi.fn(), findMany: vi.fn() },
  agentEvent: { create: vi.fn() },
  webhookSubscription: { findMany: vi.fn() },
  webhookDelivery: { createMany: vi.fn() },
  projectWorkflow: { findUnique: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-notifications", () => notifications);
vi.mock("@/lib/redesigns", () => ({
  assertRedesignOpen: vi.fn(),
  hasBlockingRedesign: vi.fn(async () => false),
}));

import { isConfirmed, submitValidation } from "./validation";
import { resetWorkflowCache } from "@/lib/workflow";

/** An issue Ada filed herself, with no agent and no claim. */
function bugRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bug1",
    tenantId: "tenant_zedu",
    projectId: "project_web",
    title: "Example issue",
    status: "open",
    assigneeId: null,
    voteCount: 3,
    severity: "medium",
    reporterId: "ada",
    beneficiaryUserId: "ada",
    duplicateOfId: null,
    createdByAgentId: null,
    createdByAgent: null,
    claims: [],
    ...overrides,
  };
}

function reviewer(id: string, ownerId: string, level: AgentLevel = "working") {
  state.agents[id] = { id, ownerUserId: ownerId, level };
  return { agentId: id, name: id, ownerId, tenantId: "tenant_zedu", level, burst: false, keyId: `key-${id}` };
}

/** A triager clears an issue as not-a-duplicate; this is the required third check. */
const clearTriage = { kind: "duplicate", verdict: "reject" };

const acceptReal = { kind: "real", verdict: "accept", severity: "high" };

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkflowCache();
  state.validations = [];
  state.agents = {};
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw.mockResolvedValue([]);
  db.bug.findFirst.mockResolvedValue(bugRow());
  db.bug.findUnique.mockResolvedValue(bugRow());
  db.membership.findUnique.mockResolvedValue({ id: "m1" });
  db.membership.findMany.mockResolvedValue([]);
  db.issueClaim.findFirst.mockResolvedValue(null);
  db.issueClaim.groupBy.mockResolvedValue([]);
  db.issueClaim.findMany.mockResolvedValue([]);
  db.issueClaim.create.mockResolvedValue({ id: "claim1", offeredAt: new Date() });
  db.redesignProposal.count.mockResolvedValue(0);
  db.pointEntry.createMany.mockResolvedValue({ count: 1 });
  db.agentAuditEvent.findMany.mockResolvedValue([]);
  db.agentEvent.create.mockResolvedValue({ id: "evt1" });
  db.webhookSubscription.findMany.mockResolvedValue([]);
  db.webhookDelivery.createMany.mockResolvedValue({ count: 0 });
  db.projectWorkflow.findUnique.mockResolvedValue(null);
  db.bugRevision.findFirst.mockResolvedValue(null);
  db.issueValidation.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    state.validations
      .filter((v) => {
        if (v.bugId !== where.bugId || v.kind !== where.kind || v.verdict !== where.verdict) return false;
        if (where.createdAt && typeof where.createdAt === "object" && "gt" in (where.createdAt as Record<string, unknown>)) {
          const gt = (where.createdAt as { gt: Date }).gt;
          if (v.createdAt && v.createdAt <= gt) return false;
        }
        return true;
      })
      .map((v) => ({
        id: v.id,
        agentId: v.agentId,
        onBehalfOfUserId: v.onBehalfOfUserId,
        agent: state.agents[v.agentId],
      })),
  );
  db.issueValidation.count.mockImplementation(async ({ where }: { where: Record<string, string> }) =>
    state.validations.filter((v) => v.bugId === where.bugId && v.kind === where.kind && v.verdict === where.verdict).length,
  );
  db.issueValidation.create.mockImplementation(async ({ data }: { data: Omit<Row, "id"> }) => {
    const duplicate = state.validations.some(
      (v) => v.bugId === data.bugId && v.agentId === data.agentId && v.kind === data.kind,
    );
    if (duplicate) {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6" });
    }
    const row = { id: `v${state.validations.length + 1}`, createdAt: new Date(), ...data };
    state.validations.push(row);
    return row;
  });
  db.issueValidation.findFirst.mockImplementation(async ({ where }: { where: Record<string, string> }) =>
    state.validations.find((v) => v.bugId === where.bugId && v.agentId === where.agentId && v.kind === where.kind) ?? null,
  );
  db.issueValidation.delete.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const row = state.validations.find((v) => v.id === where.id)!;
    state.validations = state.validations.filter((v) => v.id !== where.id);
    return row;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("submitValidation: project confirmation count (#595)", () => {
  it("requires three independent accepts when the project asks for three", async () => {
    db.projectWorkflow.findUnique.mockResolvedValue({ confirmationsNeeded: 3 });

    expect(await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal)).toMatchObject({
      status: 201,
      confirmed: false,
    });
    expect(await submitValidation(reviewer("r2", "sam"), "bug1", acceptReal)).toMatchObject({
      status: 201,
      confirmed: false,
    });
    await submitValidation(reviewer("t1", "tia", "working"), "bug1", clearTriage);
    expect(await submitValidation(reviewer("r3", "kim"), "bug1", acceptReal)).toMatchObject({
      status: 201,
      confirmed: true,
      newlyConfirmed: true,
    });
  });
});

describe("submitValidation: readable issue references (#614)", () => {
  it.each([
    ["internal id", "bug1", { id: "bug1" }],
    ["numeric issue number", "42", { number: 42 }],
    ["prefixed issue number", "ZE-42", { number: 42 }],
  ])("resolves an in-scope issue by %s before recording validation", async (_label, ref, where) => {
    db.bug.findFirst.mockResolvedValue(bugRow({ number: 42 }));

    const result = await submitValidation(reviewer("r1", "rob"), ref, acceptReal);

    expect(result).toMatchObject({ status: 201 });
    expect(db.bug.findFirst).toHaveBeenCalledWith({
      where: { ...where, tenantId: "tenant_zedu", isDeleted: false },
      select: expect.any(Object),
    });
    expect(state.validations[0]).toMatchObject({ bugId: "bug1", agentId: "r1" });
  });

  it("keeps project-scoped keys inside their project when resolving a numeric reference", async () => {
    const scopedReviewer = { ...reviewer("r1", "rob"), projectId: "project_mobile" };
    db.bug.findFirst.mockResolvedValue(null);

    expect(await submitValidation(scopedReviewer, "42", acceptReal)).toMatchObject({ status: 404, error: "not_found" });
    expect(db.bug.findFirst).toHaveBeenCalledWith({
      where: { number: 42, tenantId: "tenant_zedu", projectId: "project_mobile", isDeleted: false },
      select: expect.any(Object),
    });
    expect(db.issueValidation.create).not.toHaveBeenCalled();
  });
});

describe("recorded confirmation independence (#579)", () => {
  it.each(["beneficiaryUserId", "dispatcherUserId"] as const)("preserves reviews and clearance credited to a later claim's %s", async (claimRole) => {
    await submitValidation(reviewer("t1", "tia", "working"), "bug1", { ...clearTriage, onBehalfOfUserId: "credited-triager" });
    await submitValidation(reviewer("r1", "rob"), "bug1", { ...acceptReal, onBehalfOfUserId: "credited-reviewer" });
    // A clearance plus only one independent real accept must still fail.
    expect(await isConfirmed("bug1")).toBe(false);
    await submitValidation(reviewer("r2", "sam"), "bug1", acceptReal);
    expect(await isConfirmed("bug1")).toBe(true);

    for (const creditedUser of ["credited-triager", "credited-reviewer"]) {
      db.bug.findUnique.mockResolvedValue(bugRow({
        status: "in_progress",
        assigneeId: "worker",
        claims: [{ status: "active", releasedAt: null, beneficiaryUserId: "worker", dispatcherUserId: "dispatcher", agent: { ownerUserId: "worker" }, [claimRole]: creditedUser }],
      }));
      expect(await isConfirmed("bug1")).toBe(true);
    }
  });
});

describe("submitValidation: who may validate (#433)", () => {
  it.each([
    ["real accept", "working", acceptReal],
    ["triage clearance", "working", clearTriage],
  ] as const)("rejects a raced %s when the issue is deleted before the lock (#579)", async (_label, level, body) => {
    db.bug.findUnique.mockResolvedValue(bugRow({ isDeleted: true }));

    expect(await submitValidation(reviewer("r1", "rob", level), "bug1", body)).toMatchObject({ status: 404, error: "not_found" });
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(db.issueValidation.create).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
    expect(db.agentEvent.create).not.toHaveBeenCalled();
    expect(db.agentAuditEvent.create).not.toHaveBeenCalled();
    expect(db.bug.findUnique.mock.calls[0][0].select.isDeleted).toBe(true);
  });

  it("rejects a validation when the issue disappears before the lock (#579)", async () => {
    db.bug.findUnique.mockResolvedValue(null);
    expect(await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal)).toMatchObject({ status: 404, error: "not_found" });
    expect(db.issueValidation.create).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
    expect(db.agentEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    ["real accept", "working", acceptReal],
    ["triage clearance", "working", clearTriage],
  ] as const)("rejects a raced %s when the owner or credited person becomes the solver (#579)", async (_label, level, body) => {
    for (const conflictedUser of ["rob", "credited-person"]) {
      for (const relationship of ["assignment", "claim"] as const) {
        db.bug.findUnique.mockResolvedValueOnce(bugRow(relationship === "assignment"
          ? { assigneeId: conflictedUser }
          : { claims: [{ status: "active", releasedAt: null, beneficiaryUserId: conflictedUser, agent: { ownerUserId: "worker" } }] }));

        expect(await submitValidation(reviewer("r1", "rob", level), "bug1", {
          ...body,
          onBehalfOfUserId: "credited-person",
        })).toMatchObject({ status: 403, error: "not_independent" });
      }
    }
    expect(db.$queryRaw).toHaveBeenCalledTimes(4);
    expect(db.issueValidation.create).not.toHaveBeenCalled();
    expect(state.validations).toHaveLength(0);
  });

  it.each([
    ["real accept", acceptReal],
    ["triage clearance", clearTriage],
  ] as const)("blocks the assigned owner's %s even with independent credit", async (_label, body) => {
    db.bug.findFirst.mockResolvedValue(bugRow({ assigneeId: "rob" }));
    expect(await submitValidation(reviewer("other-agent", "rob"), "bug1", { ...body, onBehalfOfUserId: "another-person" })).toMatchObject({ status: 403, error: "not_independent" });
    expect(state.validations).toHaveLength(0);
  });

  it.each([
    ["real accept", acceptReal],
    ["triage clearance", clearTriage],
  ] as const)("blocks a filer's other agent from a %s", async (_label, body) => {
    db.bug.findFirst.mockResolvedValue(bugRow({ reporterId: "rob", beneficiaryUserId: "another-person", createdByAgentId: "filing-agent", createdByAgent: { ownerUserId: "rob" } }));
    expect(await submitValidation(reviewer("other-agent", "rob"), "bug1", body)).toMatchObject({ status: 403, error: "not_independent" });
    expect(state.validations).toHaveLength(0);
  });

  it.each(["working", "manager", "merger"] as const)("lets a %s agent validate: every class reviews", async (level) => {
    expect(await submitValidation(reviewer("c1", "cara", level), "bug1", acceptReal)).toMatchObject({ status: 201 });
  });

  it("does not run the write-budget gate for permission refusals", async () => {
    const budgetGate = vi.fn(async () => true);

    db.bug.findFirst.mockResolvedValue(bugRow({ createdByAgentId: "r1" }));
    expect(await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal, budgetGate))
      .toMatchObject({ status: 403, error: "creator_cannot_validate" });

    db.bug.findFirst.mockResolvedValue(bugRow());
    expect(await submitValidation(reviewer("r2", "ada"), "bug1", acceptReal, budgetGate))
      .toMatchObject({ status: 403, error: "not_independent" });
    expect(budgetGate).not.toHaveBeenCalled();
  });

  it("charges only after the locked independence checks and stops before writing when over budget", async () => {
    const overBudget = vi.fn(async () => false);
    expect(await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal, overBudget))
      .toMatchObject({ status: 429, error: "rate_limited" });
    expect(overBudget).toHaveBeenCalledOnce();
    expect(db.issueValidation.create).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();

    const allowed = vi.fn(async () => true);
    expect(await submitValidation(reviewer("r2", "sam"), "bug1", acceptReal, allowed))
      .toMatchObject({ status: 201 });
    expect(allowed).toHaveBeenCalledOnce();
  });

  it("does not charge when independence changes before the issue lock is acquired", async () => {
    db.bug.findUnique.mockResolvedValueOnce(bugRow({ assigneeId: "rob" }));
    const budgetGate = vi.fn(async () => true);

    expect(await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal, budgetGate))
      .toMatchObject({ status: 403, error: "not_independent" });
    expect(budgetGate).not.toHaveBeenCalled();
    expect(db.issueValidation.create).not.toHaveBeenCalled();
  });

  it("rejects the agent that filed the issue", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ createdByAgentId: "r1", createdByAgent: { ownerUserId: "rob" } }));
    expect(await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal)).toMatchObject({
      status: 403,
      error: "creator_cannot_validate",
    });
  });

  it("rejects a reviewer that isn't independent: same owner as the filing agent, or the beneficiary's own", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ createdByAgentId: "f1", createdByAgent: { ownerUserId: "rob" } }));
    expect(await submitValidation(reviewer("r2", "rob"), "bug1", acceptReal)).toMatchObject({
      status: 403,
      error: "not_independent",
    });
    db.bug.findFirst.mockResolvedValue(bugRow());
    expect(await submitValidation(reviewer("r3", "ada"), "bug1", acceptReal)).toMatchObject({
      status: 403,
      error: "not_independent",
    });
    expect(state.validations).toHaveLength(0);
  });

  it("rejects the human reporter's own agent when the beneficiary is unset (#620)", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ beneficiaryUserId: null }));
    expect(await submitValidation(reviewer("r4", "ada"), "bug1", acceptReal)).toMatchObject({
      status: 403,
      error: "not_independent",
    });
    expect(db.bug.findFirst.mock.calls[0][0].select.reporterId).toBe(true);
  });

  it("rejects validations credited to the reporter, assigned solver, or claim beneficiary (#495)", async () => {
    const reviewerAgent = reviewer("r1", "rob");
    for (const bug of [
      bugRow({ reporterId: "reporter", beneficiaryUserId: "beneficiary" }),
      bugRow({ reporterId: "reporter", beneficiaryUserId: "beneficiary", assigneeId: "solver" }),
      bugRow({ reporterId: "reporter", beneficiaryUserId: "beneficiary", claims: [
        { status: "active", releasedAt: null, beneficiaryUserId: "claimant", agent: { ownerUserId: "worker" } },
      ] }),
    ]) {
      db.bug.findFirst.mockResolvedValueOnce(bug);
    }
    for (const creditedUser of ["reporter", "solver", "claimant"]) {
      expect(await submitValidation(reviewerAgent, "bug1", { ...acceptReal, onBehalfOfUserId: creditedUser })).toMatchObject({
        status: 403,
        error: "not_independent",
      });
    }
    expect(state.validations).toHaveLength(0);
  });

  it("is 404 for an issue outside the agent's tenant or deleted", async () => {
    db.bug.findFirst.mockResolvedValue(null);
    expect(await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal)).toMatchObject({ status: 404 });
    expect(db.bug.findFirst.mock.calls[0][0].where).toEqual({ id: "bug1", tenantId: "tenant_zedu", isDeleted: false });
  });

  it("allows one validation per agent per kind", async () => {
    const rob = reviewer("r1", "rob");
    expect(await submitValidation(rob, "bug1", acceptReal)).toMatchObject({ status: 201 });
    expect(await submitValidation(rob, "bug1", acceptReal)).toMatchObject({ status: 409, error: "already_validated" });
    expect(await submitValidation(rob, "bug1", { kind: "format", verdict: "accept" })).toMatchObject({ status: 201 });
  });
});

describe("submitValidation: the body (#433)", () => {
  it("requires severity when accepting real, and only then", async () => {
    const rob = reviewer("r1", "rob");
    expect(await submitValidation(rob, "bug1", { kind: "real", verdict: "accept" })).toMatchObject({
      status: 400,
      field: "severity",
    });
    expect(await submitValidation(rob, "bug1", { kind: "format", verdict: "accept", severity: "low" })).toMatchObject({
      status: 400,
      field: "severity",
    });
    expect(await submitValidation(rob, "bug1", { kind: "real", verdict: "maybe" })).toMatchObject({ status: 400 });
  });

  it("sets the issue's severity and keeps the old one for undo", async () => {
    await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal);
    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { severity: "high" } });
    expect(state.validations[0]).toMatchObject({ severity: "high", previousSeverity: "medium" });
  });

  it("keeps the higher severity and records the disagreement (#528)", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ severity: "critical" }));
    const result = await submitValidation(reviewer("r2", "sam"), "bug1", {
      ...acceptReal,
      severity: "low",
    });
    expect(result).toMatchObject({ status: 201 });
    // The proposal is recorded on the validation, but the issue is not downgraded.
    expect(state.validations[0]).toMatchObject({ severity: "low", previousSeverity: "critical" });
    expect(db.bug.update).not.toHaveBeenCalled();
    // The disagreement is visible in the audit trail.
    const auditCalls = db.agentAuditEvent.create.mock.calls as Array<
      [{ data: { action: string; payload?: Record<string, unknown> } }]
    >;
    const auditCall = auditCalls.find((call) => call[0].data.action === "issue.validated");
    expect(auditCall?.[0].data.payload).toMatchObject({
      severityDisagreement: true,
      severity: "low",
      previousSeverity: "critical",
      effectiveSeverity: "critical",
    });
  });

  it("escalates the severity when the reviewer picks a higher one (#528)", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ severity: "low" }));
    await submitValidation(reviewer("r2", "sam"), "bug1", {
      ...acceptReal,
      severity: "critical",
    });
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "bug1" },
      data: { severity: "critical" },
    });
  });

  it("lets a duplicate verdict point at the canonical issue in the same tenant", async () => {
    db.bug.findFirst.mockResolvedValueOnce(bugRow()).mockResolvedValueOnce({ id: "bug0" });
    const result = await submitValidation(reviewer("r1", "rob", "working"), "bug1", {
      kind: "duplicate",
      verdict: "accept",
      duplicateOfId: "bug0",
    });
    expect(result).toMatchObject({ status: 201, validation: { duplicateOfId: "bug0" } });
    expect(db.bug.findFirst.mock.calls[1][0].where).toEqual({ id: "bug0", tenantId: "tenant_zedu", isDeleted: false });

    db.bug.findFirst.mockResolvedValue(bugRow());
    expect(
      await submitValidation(reviewer("r2", "sam", "working"), "bug1", { kind: "duplicate", verdict: "accept", duplicateOfId: "bug1" }),
    ).toMatchObject({ status: 400, field: "duplicateOfId" });
  });

  it("acts for the owner unless it names another member of the tenant", async () => {
    await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal);
    expect(state.validations[0]?.onBehalfOfUserId).toBe("rob");
    db.membership.findUnique.mockResolvedValue(null);
    expect(
      await submitValidation(reviewer("r2", "sam"), "bug1", { ...acceptReal, onBehalfOfUserId: "stranger" }),
    ).toMatchObject({ status: 400, field: "onBehalfOfUserId" });
  });

  it("audits every submission", async () => {
    await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal);
    expect(db.agentAuditEvent.create.mock.calls[0][0].data).toMatchObject({
      agentId: "r1",
      action: "issue.validated",
      target: "bug:bug1",
      bugId: "bug1",
    });
  });
});

describe("confirmation: the two-reviewer rule (#433)", () => {
  it("publishes issue.confirmed when the second accept confirms the issue (#534)", async () => {
    await submitValidation(reviewer("t1", "tia", "working"), "bug1", clearTriage);
    await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal);
    await submitValidation(reviewer("r2", "sam"), "bug1", acceptReal);
    const types = (db.agentEvent.create.mock.calls as Array<[{ data: { type: string } }]>).map(
      (call) => call[0].data.type,
    );
    expect(types.filter((type) => type === "issue.confirmed")).toHaveLength(1);
  });

  it("leaves a newly confirmed issue for bids and dispatch instead of offering it (#idea-verdicts)", async () => {
    db.membership.findMany.mockResolvedValue([
      { userId: "bob", user: { agents: [{ id: "agent-bob" }] } },
    ]);
    await submitValidation(reviewer("t1", "tia", "working"), "bug1", clearTriage);
    await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal);
    const result = await submitValidation(reviewer("r2", "sam"), "bug1", acceptReal);

    expect(result).toMatchObject({ status: 201, confirmed: true, newlyConfirmed: true });
    expect(db.issueClaim.create).not.toHaveBeenCalled();
    expect(db.agentEvent.create.mock.calls.map(([call]) => call.data.type)).toContain("issue.confirmed");
    expect(db.agentEvent.create.mock.calls.map(([call]) => call.data.type)).not.toContain("claim.offered");
    expect(notifications.notifyClaimOffered).not.toHaveBeenCalled();
  });

  it("one accepting reviewer does not confirm; two do, and the reporter is paid once", async () => {
    await submitValidation(reviewer("t1", "tia", "working"), "bug1", clearTriage);
    const first = await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal);
    expect(first).toMatchObject({ status: 201, confirmed: false, newlyConfirmed: false });
    expect(await isConfirmed("bug1")).toBe(false);

    const second = await submitValidation(reviewer("r2", "sam"), "bug1", { ...acceptReal, severity: "low" });
    expect(second).toMatchObject({ status: 201, confirmed: true, newlyConfirmed: true });
    expect(await isConfirmed("bug1")).toBe(true);
    expect(db.$queryRaw).toHaveBeenCalled();
    const awards = db.pointEntry.createMany.mock.calls.map((call) => call[0].data[0]);
    expect(awards).toEqual([
      {
        tenantId: "tenant_zedu",
        userId: "tia",
        bugId: "bug1",
        role: "triager",
        points: 30,
        sourceKey: "triager-clear:bug1:tia",
      },
      {
        tenantId: "tenant_zedu",
        userId: "rob",
        bugId: "bug1",
        role: "reviewer",
        points: reviewerPointsAt(0, CONFIRMATION_REVIEWER_POINTS),
        sourceKey: "reviewer-confirm:bug1:rob",
      },
      {
        tenantId: "tenant_zedu",
        userId: "sam",
        bugId: "bug1",
        role: "reviewer",
        points: reviewerPointsAt(1, CONFIRMATION_REVIEWER_POINTS),
        sourceKey: "reviewer-confirm:bug1:sam",
      },
      {
        tenantId: "tenant_zedu",
        userId: "ada",
        bugId: "bug1",
        role: "reporter",
        points: 150,
        sourceKey: "reporter:bug1:ada",
      },
    ]);

    // A third accept keeps it confirmed and pays that reviewer a smaller amount.
    const third = await submitValidation(reviewer("r3", "tia"), "bug1", acceptReal);
    expect(third).toMatchObject({ confirmed: true, newlyConfirmed: false });
    expect(db.pointEntry.createMany).toHaveBeenCalledTimes(5);
    expect(db.pointEntry.createMany.mock.calls[4][0].data[0]).toMatchObject({
      userId: "tia",
      role: "reviewer",
      points: reviewerPointsAt(2, CONFIRMATION_REVIEWER_POINTS),
      sourceKey: "reviewer-confirm:bug1:tia",
    });
  });

  it("two agents of the same owner count once", async () => {
    await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal);
    const second = await submitValidation(reviewer("r2", "rob"), "bug1", acceptReal);
    expect(second).toMatchObject({ status: 201, confirmed: false });
  });

  it("rejections and other kinds don't count", async () => {
    await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal);
    await submitValidation(reviewer("r2", "sam"), "bug1", { kind: "real", verdict: "reject" });
    await submitValidation(reviewer("r3", "tia"), "bug1", { kind: "format", verdict: "accept" });
    expect(await isConfirmed("bug1")).toBe(false);
  });

  it("keeps a reviewer's accept after their owner's agent later claims the issue (#579)", async () => {
    await submitValidation(reviewer("t1", "tia", "working"), "bug1", clearTriage);
    await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal);
    await submitValidation(reviewer("r2", "sam"), "bug1", acceptReal);
    expect(await isConfirmed("bug1")).toBe(true);

    db.bug.findUnique.mockResolvedValue(
      bugRow({
        status: "in_progress",
        assigneeId: "sam",
        claims: [{ status: "active", releasedAt: null, beneficiaryUserId: "sam", agent: { ownerUserId: "sam" } }],
      }),
    );
    expect(await isConfirmed("bug1")).toBe(true);
  });

  it("pays no reporter points on a duplicate", async () => {
    await submitValidation(reviewer("r3", "tia", "working"), "bug1", { kind: "duplicate", verdict: "accept" });
    await submitValidation(reviewer("t1", "kay", "working"), "bug1", clearTriage);
    await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal);
    const second = await submitValidation(reviewer("r2", "sam"), "bug1", acceptReal);
    expect(second).toMatchObject({ confirmed: true, newlyConfirmed: true });
    // No reporter award on a duplicate; the marker still earns the duplicate bounty.
    const roles = db.pointEntry.createMany.mock.calls.map((call) => call[0].data[0].role);
    expect(roles).not.toContain("reporter");
    expect(db.pointEntry.createMany.mock.calls[0][0].data[0]).toMatchObject({
      role: "triager",
      points: 150,
      sourceKey: "duplicate-marker:bug1:tia",
    });
  });

  it("drops confirmation when an accepting validation is undone (#450)", async () => {
    // r1's validation accepted and confirmed the issue, but is now undone.
    state.validations = [
      { id: "v1", bugId: "bug1", agentId: "r1", kind: "real", verdict: "accept", severity: "high", duplicateOfId: null, onBehalfOfUserId: "rob" },
    ];
    state.agents = { r1: { id: "r1", ownerUserId: "rob" }, r2: { id: "r2", ownerUserId: "sam" } };
    db.agentAuditEvent.findMany.mockResolvedValue([{ payload: { validationId: "v1" }, undoneAt: new Date() }]);

    const result = await submitValidation(reviewer("r2", "sam"), "bug1", acceptReal);
    expect(result).toMatchObject({ status: 201, confirmed: false, newlyConfirmed: false });
  });

  it("isConfirmed is false for an unknown issue", async () => {
    db.bug.findUnique.mockResolvedValue(null);
    expect(await isConfirmed("nope")).toBe(false);
  });

  it("drops confirmation when an issue was edited and validations are from the previous revision (#713)", async () => {
    const t0 = new Date("2026-10-20T10:00:00Z");
    const tEdit = new Date("2026-10-20T11:00:00Z");
    const tAfter = new Date("2026-10-20T12:00:00Z");

    // Two validations plus a triage clear confirm the issue initially
    state.validations = [
      { id: "v1", bugId: "bug1", agentId: "r1", kind: "real", verdict: "accept", severity: "high", duplicateOfId: null, onBehalfOfUserId: "rob", createdAt: t0 },
      { id: "v2", bugId: "bug1", agentId: "r2", kind: "real", verdict: "accept", severity: "high", duplicateOfId: null, onBehalfOfUserId: "sam", createdAt: t0 },
      { id: "vt", bugId: "bug1", agentId: "t1", kind: "duplicate", verdict: "reject", severity: null, duplicateOfId: null, onBehalfOfUserId: "tia", createdAt: t0 },
    ];
    state.agents = {
      r1: { id: "r1", ownerUserId: "rob" },
      r2: { id: "r2", ownerUserId: "sam" },
      t1: { id: "t1", ownerUserId: "tia", level: "working" },
    };

    // Initially confirmed
    expect(await isConfirmed("bug1")).toBe(true);

    // Issue was edited at tEdit (after t0)
    db.bugRevision.findFirst.mockResolvedValue({ editedAt: tEdit });

    // The replacement report is NOT confirmed because validations are for previous content
    expect(await isConfirmed("bug1")).toBe(false);

    // When reviewers validate the new report after the edit, it confirms again
    state.validations.push(
      { id: "v3", bugId: "bug1", agentId: "r1_new", kind: "real", verdict: "accept", severity: "high", duplicateOfId: null, onBehalfOfUserId: "rob", createdAt: tAfter },
      { id: "v4", bugId: "bug1", agentId: "r2_new", kind: "real", verdict: "accept", severity: "high", duplicateOfId: null, onBehalfOfUserId: "sam", createdAt: tAfter },
      { id: "vt2", bugId: "bug1", agentId: "t1", kind: "duplicate", verdict: "reject", severity: null, duplicateOfId: null, onBehalfOfUserId: "tia", createdAt: tAfter },
    );
    state.agents.r1_new = { id: "r1_new", ownerUserId: "rob" };
    state.agents.r2_new = { id: "r2_new", ownerUserId: "sam" };

    expect(await isConfirmed("bug1")).toBe(true);
  });
});

describe("confirmation: the triage clearance", () => {
  it.each(["real", "duplicate"])("ignores historical %s validations credited to the issue owner", async (kind) => {
    reviewer("r1", "rob");
    reviewer("r2", "sam");
    reviewer("t1", "tia", "working");
    state.validations = [
      { id: "v1", bugId: "bug1", agentId: "r1", kind: "real", verdict: "accept", severity: "high", duplicateOfId: null, onBehalfOfUserId: kind === "real" ? "ada" : "rob" },
      { id: "v2", bugId: "bug1", agentId: "r2", kind: "real", verdict: "accept", severity: "high", duplicateOfId: null, onBehalfOfUserId: "sam" },
      { id: "vt", bugId: "bug1", agentId: "t1", kind: "duplicate", verdict: "reject", severity: null, duplicateOfId: null, onBehalfOfUserId: kind === "duplicate" ? "ada" : "tia" },
    ];
    expect(await isConfirmed("bug1")).toBe(false);
  });
  it("needs a not-a-duplicate verdict on top of the two accepts", async () => {
    await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal);
    await submitValidation(reviewer("r2", "sam"), "bug1", acceptReal);
    expect(await isConfirmed("bug1")).toBe(false);

    const clear = await submitValidation(reviewer("t1", "tia", "working"), "bug1", clearTriage);
    expect(clear).toMatchObject({ status: 201, confirmed: true, newlyConfirmed: true });
    expect(await isConfirmed("bug1")).toBe(true);
  });

  it("moves a confirmed issue from Requires confirmation to Open, and leaves it there until then (#requires-confirmation)", async () => {
    const waiting = bugRow({ status: "requires_confirmation" });
    db.bug.findFirst.mockResolvedValue(waiting);
    db.bug.findUnique.mockResolvedValue(waiting);
    await submitValidation(reviewer("r1", "rob"), "bug1", acceptReal);
    await submitValidation(reviewer("r2", "sam"), "bug1", acceptReal);
    expect(db.bug.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: { status: "open" } }));

    await submitValidation(reviewer("t1", "tia", "working"), "bug1", clearTriage);
    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { status: "open" } });
    expect(db.bugActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ bugId: "bug1", type: "status_changed", metadata: { from: "requires_confirmation", to: "open", via: "confirmed" } }),
    });
  });

  it.each(["working", "manager", "merger"] as const)("lets a %s agent clear triage and give any other verdict", async (level) => {
    const t = reviewer("t1", "tia", level);
    expect(await submitValidation(t, "bug1", clearTriage)).toMatchObject({ status: 201 });
    expect(await submitValidation(t, "bug1", acceptReal)).toMatchObject({ status: 201 });
  });

  it("drops confirmation when the triage clearance is undone", async () => {
    state.validations = [
      { id: "v1", bugId: "bug1", agentId: "r1", kind: "real", verdict: "accept", severity: "high", duplicateOfId: null, onBehalfOfUserId: "rob" },
      { id: "v2", bugId: "bug1", agentId: "r2", kind: "real", verdict: "accept", severity: "high", duplicateOfId: null, onBehalfOfUserId: "sam" },
      { id: "vt", bugId: "bug1", agentId: "t1", kind: "duplicate", verdict: "reject", severity: null, duplicateOfId: null, onBehalfOfUserId: "tia" },
    ];
    state.agents = {
      r1: { id: "r1", ownerUserId: "rob" },
      r2: { id: "r2", ownerUserId: "sam" },
      t1: { id: "t1", ownerUserId: "tia", level: "working" },
    };
    expect(await isConfirmed("bug1")).toBe(true);

    db.agentAuditEvent.findMany.mockResolvedValue([{ payload: { validationId: "vt" }, undoneAt: new Date() }]);
    expect(await isConfirmed("bug1")).toBe(false);
  });

  it("keeps a triager's clear after the clearing owner wins the bid (#579)", async () => {
    state.validations = [
      { id: "v1", bugId: "bug1", agentId: "r1", kind: "real", verdict: "accept", severity: "high", duplicateOfId: null, onBehalfOfUserId: "rob" },
      { id: "v2", bugId: "bug1", agentId: "r2", kind: "real", verdict: "accept", severity: "high", duplicateOfId: null, onBehalfOfUserId: "sam" },
      { id: "vt", bugId: "bug1", agentId: "t1", kind: "duplicate", verdict: "reject", severity: null, duplicateOfId: null, onBehalfOfUserId: "tia" },
    ];
    state.agents = {
      r1: { id: "r1", ownerUserId: "rob" },
      r2: { id: "r2", ownerUserId: "sam" },
      t1: { id: "t1", ownerUserId: "tia", level: "working" },
    };
    expect(await isConfirmed("bug1")).toBe(true);

    // The triager's owner wins the bid after clearing it. That is a later
    // claim, not a conflict when the clearance was recorded, so it must not
    // retroactively un-confirm the issue.
    db.bug.findUnique.mockResolvedValue(
      bugRow({
        status: "in_progress",
        assigneeId: "tia",
        claims: [{ status: "active", releasedAt: null, beneficiaryUserId: "tia", agent: { ownerUserId: "tia" } }],
      }),
    );
    expect(await isConfirmed("bug1")).toBe(true);
  });
});

describe("re-review after an edit (#493)", () => {
  const tBefore = new Date("2026-10-21T20:00:00Z");
  const tEdit = new Date("2026-10-21T21:02:00Z");

  it("lets the same reviewers re-accept after an edit, and the issue confirms", async () => {
    const rob = reviewer("r1", "rob");
    const sam = reviewer("r2", "sam");
    const tia = reviewer("t1", "tia", "working");
    // Rob and Sam accepted, then the issue was edited, voiding both.
    state.validations = [
      { id: "v1", bugId: "bug1", agentId: "r1", kind: "real", verdict: "accept", severity: "high", duplicateOfId: null, onBehalfOfUserId: "rob", createdAt: tBefore },
      { id: "v2", bugId: "bug1", agentId: "r2", kind: "real", verdict: "accept", severity: "high", duplicateOfId: null, onBehalfOfUserId: "sam", createdAt: tBefore },
    ];
    db.bugRevision.findFirst.mockResolvedValue({ editedAt: tEdit });
    expect(await submitValidation(tia, "bug1", clearTriage)).toMatchObject({ status: 201 });
    expect(await isConfirmed("bug1")).toBe(false);

    // Before #493 these were 409 already_validated forever.
    expect(await submitValidation(rob, "bug1", acceptReal)).toMatchObject({ status: 201 });
    const second = await submitValidation(sam, "bug1", acceptReal);
    expect(second).toMatchObject({ status: 201, newlyConfirmed: true });
    expect(await isConfirmed("bug1")).toBe(true);

    // The stale rows were replaced (new ids), not duplicated.
    const real = state.validations.filter((v) => v.kind === "real");
    expect(real).toHaveLength(2);
    expect(real.map((v) => v.id)).not.toContain("v1");
    expect(real.map((v) => v.id)).not.toContain("v2");
    expect(db.issueValidation.delete).toHaveBeenCalledTimes(2);
  });

  it("still refuses a second validation when nothing was edited since", async () => {
    const rob = reviewer("r1", "rob");
    db.bugRevision.findFirst.mockResolvedValue({ editedAt: tEdit });
    expect(await submitValidation(rob, "bug1", acceptReal)).toMatchObject({ status: 201 });
    expect(await submitValidation(rob, "bug1", acceptReal)).toMatchObject({ status: 409, error: "already_validated" });
    expect(db.issueValidation.delete).not.toHaveBeenCalled();
  });

  it("lets a triager re-clear an issue after an edit", async () => {
    const tia = reviewer("t1", "tia", "working");
    state.validations = [
      { id: "vt", bugId: "bug1", agentId: "t1", kind: "duplicate", verdict: "reject", severity: null, duplicateOfId: null, onBehalfOfUserId: "tia", createdAt: tBefore },
    ];
    db.bugRevision.findFirst.mockResolvedValue({ editedAt: tEdit });
    expect(await submitValidation(tia, "bug1", clearTriage)).toMatchObject({ status: 201 });
  });
});

describe("re-review after an undone review (#493, CodeRabbit)", () => {
  it("counts the replacement even when the old review was undone", async () => {
    const tBefore = new Date("2026-10-21T20:00:00Z");
    const rob = reviewer("r1", "rob");
    const sam = reviewer("r2", "sam");
    const tia = reviewer("t1", "tia", "working");
    state.validations = [
      { id: "v-old", bugId: "bug1", agentId: "r1", kind: "real", verdict: "accept", severity: "high", duplicateOfId: null, onBehalfOfUserId: "rob", createdAt: tBefore },
    ];
    // An admin undid Rob's old review, then the issue was edited.
    db.agentAuditEvent.findMany.mockResolvedValue([{ payload: { validationId: "v-old" } }]);
    db.bugRevision.findFirst.mockResolvedValue({ editedAt: new Date("2026-10-21T21:02:00Z") });

    expect(await submitValidation(tia, "bug1", clearTriage)).toMatchObject({ status: 201 });
    expect(await submitValidation(rob, "bug1", acceptReal)).toMatchObject({ status: 201 });
    expect(await submitValidation(sam, "bug1", acceptReal)).toMatchObject({ status: 201, newlyConfirmed: true });
    expect(state.validations.some((v) => v.id === "v-old")).toBe(false);
  });
});
