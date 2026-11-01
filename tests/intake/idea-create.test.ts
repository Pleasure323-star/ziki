import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Creating an idea (#441, #idea-table): one create per idempotency key, a
 * similar report is flagged until acknowledged, and an idea is only visible
 * inside its own project.
 */
const db = vi.hoisted(() => ({
  idempotencyKey: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  issueType: { findUnique: vi.fn() },
  bug: { findMany: vi.fn() },
  idea: { findMany: vi.fn(), findFirst: vi.fn(), findUniqueOrThrow: vi.fn() },
  ideaVerdict: { groupBy: vi.fn(async () => []) },
  projectWorkflow: { findUnique: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { createIdeaWithPolicy, type CreatePolicyInput } from "@/lib/agent-api/create-policy";
import { listAgentIdeas, readAgentIdea } from "@/lib/agent-api/ideas";

const NOW = new Date("2026-10-19T12:00:00Z");
const agent = { agentId: "agent1", tenantId: "tenant_zedu" };
const scope = { tenantId: "t1", projectId: "p1" };
const insert = vi.fn();
const input = (overrides: Partial<CreatePolicyInput> = {}): CreatePolicyInput => ({
  agent,
  projectId: "project_zedu",
  idempotencyKey: "3f1c-key",
  requestHash: "request-hash",
  title: "Login button does nothing on Safari",
  insert,
  now: NOW,
  ...overrides,
});
const similarRow = { id: "b1", number: 12, title: "Login button does nothing in Safari", status: "open", voteCount: 3, score: 0.8 };
const idea = {
  id: "i1", number: 12, title: "Export activity as CSV", summary: "People want a CSV.", description: "People want their data.",
  status: "open" as const, score: 3, typeId: null, categoryId: null, areaId: null, proofLinks: [], projectId: "p1",
  reporterId: "ada", beneficiaryUserId: "ada", createdByAgentId: null, convertedAt: null, archiveReason: null,
  archiveEvidence: null, archiveDuplicateOf: null, archivedAt: null, archivedByAgentId: null,
  createdAt: new Date("2026-10-20T10:00:00Z"), updatedAt: new Date("2026-10-20T10:00:00Z"), area: null, issue: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.idempotencyKey.findUnique.mockResolvedValue(null);
  db.idempotencyKey.create.mockResolvedValue({ id: "ik1" });
  db.$queryRaw.mockResolvedValue([]);
  db.projectWorkflow.findUnique.mockResolvedValue(null);
  db.idea.findMany.mockResolvedValue([idea]);
  db.idea.findFirst.mockResolvedValue({ id: "i1" });
  db.idea.findUniqueOrThrow.mockResolvedValue({ ...idea, attachments: [] });
  insert.mockResolvedValue({ id: "new-idea" });
});

describe("creating an idea", () => {
  it("needs an idempotency key, and writes nothing without one", async () => {
    expect(await createIdeaWithPolicy(input({ idempotencyKey: "" }))).toMatchObject({ status: 400, error: "missing_idempotency_key" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("creates once per key, and refuses the same key with a different body", async () => {
    expect(await createIdeaWithPolicy(input())).toEqual({ status: 201, ideaId: "new-idea", replayed: false });
    db.idempotencyKey.findUnique.mockResolvedValue({ ideaId: "new-idea", requestHash: "request-hash", createdAt: NOW });
    expect(await createIdeaWithPolicy(input({ requestHash: "different-hash" }))).toMatchObject({ status: 409, error: "idempotency_conflict" });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("replays the winner when a concurrent retry takes the key first", async () => {
    db.idempotencyKey.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6" }));
    db.idempotencyKey.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ideaId: "winner", requestHash: "request-hash", createdAt: NOW });
    expect(await createIdeaWithPolicy(input())).toEqual({ status: 200, ideaId: "winner", replayed: true });
    expect(insert).not.toHaveBeenCalled();
  });

  it("flags a similar report in this tenant and project until it is acknowledged", async () => {
    db.$queryRaw.mockResolvedValue([similarRow]);
    expect(await createIdeaWithPolicy(input())).toMatchObject({ status: 409, error: "similar_issues" });
    const values = (db.$queryRaw.mock.calls[0] as unknown[]).slice(1);
    expect(values).toEqual(expect.arrayContaining(["tenant_zedu", "project_zedu"]));
    expect(await createIdeaWithPolicy(input({ acknowledgeSimilar: true }))).toMatchObject({ status: 201 });
  });
});

describe("seeing an idea", () => {
  it("reads it only inside its own project, and is a 404 elsewhere", async () => {
    await readAgentIdea(scope, "12");
    expect(db.idea.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { ...scope, isDeleted: false, number: 12 } }));
    db.idea.findFirst.mockResolvedValue(null);
    await expect(readAgentIdea(scope, "12")).rejects.toMatchObject({ status: 404 });
  });

  it("lists the project's ideas and names a bad filter", async () => {
    const page = await listAgentIdeas(scope, new URLSearchParams("status=open"));
    expect(db.idea.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1", projectId: "p1", isDeleted: false, status: "open" });
    expect(page.items[0]).toMatchObject({ id: "i1", convertible: true });
    await expect(listAgentIdeas(scope, new URLSearchParams("status=idea"))).rejects.toMatchObject({ status: 400 });
  });
});
