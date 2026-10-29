import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIRMATION_REVIEWER_POINTS, reviewerPointsAt } from "@/lib/points/rules";

type Entry = {
  id: string;
  bugId: string;
  onBehalfOfUserId: string;
  agentId: string | null;
  verdict: "confirm" | "reject" | "neutral";
  summary: string;
  description: string;
  severity: string | null;
  previousSeverity: string | null;
  duplicateOfId: string | null;
  undoneAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const state = vi.hoisted(() => ({
  bug: {} as Record<string, unknown>,
  entries: [] as Entry[],
  agentOwners: {} as Record<string, string>,
  points: [] as Array<{ sourceKey: string; userId: string; role: string; points: number }>,
  clock: 0,
  otherIssues: [] as Array<{ id: string; number: number }>,
}));

const db = vi.hoisted(() => ({
  bug: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  bugRevision: { findMany: vi.fn() },
  bugActivity: { create: vi.fn() },
  issueConfirmation: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
  pointEntry: { createMany: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
const publish = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-api/events", () => ({ publish }));
const audit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/audit", () => ({ audit }));
vi.mock("@/lib/workflow", () => ({ workflowFor: vi.fn(async () => ({ confirmationsNeeded: 2 })) }));

import { confirmationSchema, giveConfirmation, isConfirmed, listConfirmations } from "./confirmations";
import { IssueApiError } from "./errors";

const scope = { tenantId: "t1", projectId: "p1" };
const agentOf = (id: string, owner: string) => {
  state.agentOwners[id] = owner;
  return { tenantId: "t1", userId: owner, agent: { id, level: "working" as const } };
};
const person = (userId: string) => ({ tenantId: "t1", userId });
const body = (verdict: string, extra: Record<string, unknown> = {}) => ({
  verdict,
  summary: "Reproduced it on staging.",
  description: "Followed the steps; it fails as reported and no other issue matches.",
  ...extra,
});

function bugRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bug1",
    number: 7,
    tenantId: "t1",
    projectId: "p1",
    status: "requires_confirmation",
    severity: "medium",
    isDeleted: false,
    reporterId: "ada",
    beneficiaryUserId: "ada",
    assigneeId: null,
    duplicateOfId: null,
    createdByAgentId: "agent-ada",
    createdByAgent: { ownerUserId: "ada" },
    claims: [],
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<IssueApiError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(IssueApiError);
  return error as IssueApiError;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.bug = bugRow();
  state.entries = [];
  state.agentOwners = {};
  state.points = [];
  state.clock = 0;
  state.otherIssues = [{ id: "bug0", number: 3 }];
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw.mockResolvedValue([]);
  db.bug.findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.id === state.bug.id || where.number === state.bug.number) return state.bug;
    return state.otherIssues.find((issue) => issue.id === where.id || issue.number === where.number) ?? null;
  });
  db.bug.findUnique.mockImplementation(async () => state.bug);
  db.bug.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    where.id === state.bug.id ? [state.bug] : state.otherIssues.filter((issue) => (where.id as { in?: string[] })?.in?.includes(issue.id)),
  );
  db.bug.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    state.bug = { ...state.bug, ...data };
    return state.bug;
  });
  db.bugRevision.findMany.mockResolvedValue([]);
  db.bugActivity.create.mockResolvedValue({});
  db.pointEntry.createMany.mockImplementation(async ({ data }: { data: Array<{ sourceKey: string; userId: string; role: string; points: number }> }) => {
    const fresh = data.filter((row) => !state.points.some((p) => p.sourceKey === row.sourceKey));
    state.points.push(...fresh);
    return { count: fresh.length };
  });
  db.issueConfirmation.findUnique.mockImplementation(async ({ where }: { where: { bugId_onBehalfOfUserId: { onBehalfOfUserId: string } } }) =>
    state.entries.find((e) => e.onBehalfOfUserId === where.bugId_onBehalfOfUserId.onBehalfOfUserId) ?? null,
  );
  db.issueConfirmation.upsert.mockImplementation(async ({ where, create, update }: {
    where: { bugId_onBehalfOfUserId: { onBehalfOfUserId: string } };
    create: Omit<Entry, "id" | "createdAt" | "updatedAt">;
    update: Partial<Entry>;
  }) => {
    const at = new Date(Date.UTC(2026, 11, 4, 10, ++state.clock));
    const existing = state.entries.find((e) => e.onBehalfOfUserId === where.bugId_onBehalfOfUserId.onBehalfOfUserId);
    if (existing) {
      Object.assign(existing, update, { updatedAt: at });
      return existing;
    }
    const row = { ...create, id: `c${state.entries.length + 1}`, createdAt: at, updatedAt: at } as Entry;
    state.entries.push(row);
    return row;
  });
  db.issueConfirmation.findMany.mockImplementation(async ({ where }: { where: { verdict?: { in: string[] }; undoneAt?: null } }) =>
    state.entries
      .filter((e) => (!where.verdict || where.verdict.in.includes(e.verdict)) && (where.undoneAt !== null || !e.undoneAt))
      .map((e) => ({
        ...e,
        agent: e.agentId ? { ownerUserId: state.agentOwners[e.agentId], name: e.agentId } : null,
        onBehalfOf: { name: e.onBehalfOfUserId },
        replies: [],
      })),
  );
});

describe("confirmationSchema (#issue-confirmations)", () => {
  it("takes a verdict with a summary and a description", () => {
    expect(confirmationSchema.safeParse(body("confirm", { severity: "high" })).success).toBe(true);
    expect(confirmationSchema.safeParse(body("reject", { duplicateOfId: "3" })).success).toBe(true);
    expect(confirmationSchema.safeParse(body("neutral")).success).toBe(true);
  });

  it("refuses severity off confirm, duplicateOfId off reject, and unknown fields", () => {
    expect(confirmationSchema.safeParse(body("reject", { severity: "high" })).success).toBe(false);
    expect(confirmationSchema.safeParse(body("confirm", { duplicateOfId: "3" })).success).toBe(false);
    expect(confirmationSchema.safeParse(body("confirm", { kind: "real" })).success).toBe(false);
  });
});

describe("giveConfirmation (#issue-confirmations)", () => {
  it("records an agent's entry for its owner, and two independent confirms confirm the issue", async () => {
    const first = await giveConfirmation(agentOf("agent-bob", "bob"), scope, "bug1", body("confirm", { severity: "high" }));
    expect(first).toMatchObject({ replaced: false, confirmed: false, newlyConfirmed: false, confirmations: 1, confirmationsNeeded: 2 });
    expect(first.confirmation).toMatchObject({ verdict: "confirm", severity: "high", onBehalfOfUserId: "bob", agentId: "agent-bob" });
    // Severity escalates from medium to high.
    expect(state.bug.severity).toBe("high");

    const second = await giveConfirmation(person("cara"), scope, "7", body("confirm"));
    expect(second).toMatchObject({ confirmed: true, newlyConfirmed: true, confirmations: 2 });
    expect(state.bug.status).toBe("open");
    expect(db.bugActivity.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "status_changed" }) }));

    // Points: each counted confirm earns the reviewer award and the clearance; the reporter is paid once.
    expect(state.points.map((p) => p.sourceKey).sort()).toEqual([
      "reporter:bug1:ada",
      "reviewer-confirm:bug1:bob",
      "reviewer-confirm:bug1:cara",
      "triager-clear:bug1:bob",
      "triager-clear:bug1:cara",
    ]);
    expect(state.points.find((p) => p.sourceKey === "reviewer-confirm:bug1:cara")?.points).toBe(reviewerPointsAt(1, CONFIRMATION_REVIEWER_POINTS));

    // Events agents already subscribe to; only the agent's entry is audited.
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "issue.validated", actorAgentId: "agent-bob" }));
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "issue.validated", actorAgentId: null }));
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({ type: "issue.confirmed" }));
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      { agentId: "agent-bob", tenantId: "t1" },
      "issue.validated",
      "bug:bug1",
      expect.objectContaining({ confirmationId: first.confirmation.id, validationId: first.confirmation.id, verdict: "confirm", entryAt: expect.any(String) }),
      expect.anything(),
    );
    expect(await isConfirmed("bug1")).toBe(true);
  });

  it("refuses a bare verdict with 400 naming the field", async () => {
    const bare = await rejection(giveConfirmation(person("bob"), scope, "bug1", { verdict: "confirm" }));
    expect(bare.status).toBe(400);
    expect(bare.body).toMatchObject({ error: "invalid_request", field: "summary" });
    const noDescription = await rejection(giveConfirmation(person("bob"), scope, "bug1", { verdict: "reject", summary: "Not real." }));
    expect(noDescription.body).toMatchObject({ field: "description" });
    const badVerdict = await rejection(giveConfirmation(person("bob"), scope, "bug1", body("accept")));
    expect(badVerdict.body).toMatchObject({ field: "verdict" });
    expect(db.issueConfirmation.upsert).not.toHaveBeenCalled();
  });

  it("keeps independence: not the filing agent, the reporter (agent or person), or whoever holds the claim", async () => {
    expect((await rejection(giveConfirmation(agentOf("agent-ada", "ada"), scope, "bug1", body("confirm")))).body).toMatchObject({ error: "creator_cannot_confirm" });
    expect((await rejection(giveConfirmation(person("ada"), scope, "bug1", body("confirm")))).body).toMatchObject({ error: "not_independent" });
    state.bug = bugRow({ beneficiaryUserId: "ben" });
    expect((await rejection(giveConfirmation(person("ben"), scope, "bug1", body("confirm")))).status).toBe(403);
    state.bug = bugRow({ claims: [{ status: "active", releasedAt: null, beneficiaryUserId: "sol", agent: { ownerUserId: "sol" } }] });
    expect((await rejection(giveConfirmation(agentOf("agent-sol", "sol"), scope, "bug1", body("confirm")))).status).toBe(403);
    expect(db.issueConfirmation.upsert).not.toHaveBeenCalled();
  });

  it("takes entries only at Requires confirmation, and 404s an unknown issue", async () => {
    state.bug = bugRow({ status: "open" });
    expect((await rejection(giveConfirmation(person("bob"), scope, "bug1", body("confirm")))).body).toMatchObject({ error: "not_confirming" });
    expect((await rejection(giveConfirmation(person("bob"), scope, "nope", body("confirm")))).status).toBe(404);
  });

  it("marks a duplicate with a reject naming another issue, and pays the marker", async () => {
    const given = await giveConfirmation(person("bob"), scope, "bug1", body("reject", { duplicateOfId: "#3" }));
    expect(given.confirmation).toMatchObject({ verdict: "reject", duplicateOfId: "bug0", severity: null });
    expect(state.points.map((p) => p.sourceKey)).toEqual(["duplicate-marker:bug1:bob"]);
    expect((await rejection(giveConfirmation(person("cara"), scope, "bug1", body("reject", { duplicateOfId: "bug1" })))).body).toMatchObject({ field: "duplicateOfId" });

    // A duplicate earns its confirmers' reviewer award and its reporter nothing.
    await giveConfirmation(person("cara"), scope, "bug1", body("confirm"));
    const last = await giveConfirmation(person("dan"), scope, "bug1", body("confirm"));
    expect(last.confirmed).toBe(true);
    expect(state.points.map((p) => p.sourceKey).sort()).toEqual([
      "duplicate-marker:bug1:bob",
      "triager-clear:bug1:cara",
      "triager-clear:bug1:dan",
    ]);
  });

  it("counts neutral for nothing", async () => {
    await giveConfirmation(person("bob"), scope, "bug1", body("neutral"));
    const second = await giveConfirmation(person("cara"), scope, "bug1", body("neutral"));
    expect(second).toMatchObject({ confirmed: false, confirmations: 0 });
    expect(state.points).toEqual([]);
  });

  it("replaces the person's earlier entry instead of adding one", async () => {
    await giveConfirmation(person("bob"), scope, "bug1", body("reject"));
    const changed = await giveConfirmation(agentOf("agent-bob", "bob"), scope, "bug1", body("confirm", { summary: "I was wrong." }));
    expect(changed).toMatchObject({ replaced: true, confirmations: 1 });
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({ verdict: "confirm", summary: "I was wrong.", agentId: "agent-bob", undoneAt: null });
  });
});

describe("listConfirmations", () => {
  it("lists every entry with whether it counts and the issue it duplicates", async () => {
    await giveConfirmation(person("bob"), scope, "bug1", body("confirm"));
    await giveConfirmation(person("cara"), scope, "bug1", body("reject", { duplicateOfId: "3" }));
    await giveConfirmation(person("dan"), scope, "bug1", body("neutral"));
    const listed = await listConfirmations(scope, "bug1");
    expect(listed).toMatchObject({ issueId: "bug1", issueNumber: 7, confirmations: 1, rejections: 1, confirmationsNeeded: 2, confirmed: false });
    expect(listed.entries.map((e) => [e.by, e.verdict, e.counted])).toEqual([
      ["bob", "confirm", true],
      ["cara", "reject", true],
      ["dan", "neutral", false],
    ]);
    expect(listed.entries[1].duplicateOf).toEqual({ id: "bug0", number: 3 });
  });
});
