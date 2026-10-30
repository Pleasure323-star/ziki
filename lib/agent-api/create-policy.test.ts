import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const mock = {
    idempotencyKey: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    issueType: { findUnique: vi.fn() },
    bug: { findMany: vi.fn() },
    idea: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return mock;
});
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import {
  createIdeaWithPolicy,
  cursorWhere,
  decodeCursor,
  encodeCursor,
  isAcknowledged,
  pageSize,
  parseIdempotencyKey,
  toPage,
  type CreatePolicyInput,
} from "./create-policy";

const NOW = new Date("2026-10-19T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const agent = { agentId: "agent1", tenantId: "tenant_zedu" };

const insert = vi.fn();
function input(overrides: Partial<CreatePolicyInput> = {}): CreatePolicyInput {
  return {
    agent,
    projectId: "project_zedu",
    idempotencyKey: "3f1c-key",
    requestHash: "request-hash",
    title: "Login button does nothing on Safari",
    insert,
    now: NOW,
    ...overrides,
  };
}

const similarRow = {
  id: "b1",
  number: 12,
  title: "Login button does nothing in Safari",
  status: "open",
  voteCount: 3,
  score: 0.8,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.idempotencyKey.findUnique.mockResolvedValue(null);
  db.idempotencyKey.create.mockResolvedValue({ id: "ik1" });
  db.$queryRaw.mockResolvedValue([]);
  insert.mockResolvedValue({ id: "new-bug" });
});

describe("createIdeaWithPolicy: idempotency (#441)", () => {
  it("requires a key: a missing one is 400 and nothing is written", async () => {
    for (const idempotencyKey of [undefined, null, "", "   "]) {
      expect(await createIdeaWithPolicy(input({ idempotencyKey }))).toMatchObject({
        status: 400,
        error: "missing_idempotency_key",
      });
    }
    expect(await createIdeaWithPolicy(input({ idempotencyKey: "has space" }))).toMatchObject({
      status: 400,
      error: "invalid_idempotency_key",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("creates once and records the key against the new issue", async () => {
    expect(await createIdeaWithPolicy(input())).toEqual({ status: 201, ideaId: "new-bug", replayed: false });
    expect(db.idempotencyKey.create).toHaveBeenCalledWith({
      data: { agentId: "agent1", key: "3f1c-key", requestHash: "request-hash", createdAt: NOW },
      select: { id: true },
    });
    expect(db.idempotencyKey.update).toHaveBeenCalledWith({ where: { id: "ik1" }, data: { ideaId: "new-bug" } });
  });

  it("rejects a different request body for a key within 24 hours", async () => {
    db.idempotencyKey.findUnique.mockResolvedValue({ ideaId: "first-bug", requestHash: "original-hash", createdAt: new Date(NOW.getTime() - 23 * HOUR) });
    expect(await createIdeaWithPolicy(input({ requestHash: "different-hash" }))).toEqual({
      status: 409,
      error: "idempotency_conflict",
      message: "This Idempotency-Key was already used with a different request body.",
    });
    expect(db.idempotencyKey.findUnique.mock.calls[0][0].where).toEqual({
      agentId_key: { agentId: "agent1", key: "3f1c-key" },
    });
    expect(insert).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("treats a key older than 24 hours as new, and clears the old row", async () => {
    db.idempotencyKey.findUnique.mockResolvedValue({ ideaId: "old-bug", createdAt: new Date(NOW.getTime() - 25 * HOUR) });
    expect(await createIdeaWithPolicy(input())).toMatchObject({ status: 201, ideaId: "new-bug" });
    expect(db.idempotencyKey.deleteMany).toHaveBeenCalledWith({
      where: { agentId: "agent1", key: "3f1c-key", createdAt: { lte: new Date(NOW.getTime() - 24 * HOUR) } },
    });
  });

  it("replays the winner when a concurrent retry takes the key first", async () => {
    db.idempotencyKey.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6" }),
    );
    db.idempotencyKey.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ideaId: "winner-bug", requestHash: "request-hash", createdAt: NOW });
    expect(await createIdeaWithPolicy(input())).toEqual({ status: 200, ideaId: "winner-bug", replayed: true });
    expect(insert).not.toHaveBeenCalled();
  });

  it("rethrows other database errors", async () => {
    insert.mockRejectedValue(new Error("db down"));
    await expect(createIdeaWithPolicy(input())).rejects.toThrow("db down");
  });

  it("scopes keys to the agent: another agent's key is not a replay", async () => {
    await createIdeaWithPolicy(input({ agent: { agentId: "agent2", tenantId: "tenant_zedu" } }));
    expect(db.idempotencyKey.findUnique.mock.calls[0][0].where.agentId_key.agentId).toBe("agent2");
  });
});

describe("createIdeaWithPolicy: similar issues (#441)", () => {
  it("is 409 with the matches until acknowledged", async () => {
    db.$queryRaw.mockResolvedValue([similarRow]);
    const result = await createIdeaWithPolicy(input());
    expect(result).toMatchObject({ status: 409, error: "similar_issues" });
    expect(result.status === 409 && "matches" in result ? result.matches : []).toEqual([
      { id: "b1", number: 12, title: "Login button does nothing in Safari", status: "open", voteCount: 3 },
    ]);
    expect(insert).not.toHaveBeenCalled();
    // Nothing was held, so the agent can repeat the same key.
    expect(db.idempotencyKey.create).not.toHaveBeenCalled();

    expect(await createIdeaWithPolicy(input({ acknowledgeSimilar: true }))).toMatchObject({ status: 201 });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("replays instead of 409 when a concurrent retry made the 'similar' issue", async () => {
    db.$queryRaw.mockResolvedValue([similarRow]);
    db.idempotencyKey.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ideaId: "b1", requestHash: "request-hash", createdAt: NOW });
    expect(await createIdeaWithPolicy(input())).toEqual({ status: 200, ideaId: "b1", replayed: true });
    expect(insert).not.toHaveBeenCalled();
  });

  it("only searches this tenant and project", async () => {
    await createIdeaWithPolicy(input());
    const values = (db.$queryRaw.mock.calls[0] as unknown[]).slice(1);
    expect(values).toContain("tenant_zedu");
    expect(values).toContain("project_zedu");
  });

  it("ignores weak matches", async () => {
    db.$queryRaw.mockResolvedValue([{ ...similarRow, score: 0.1 }]);
    expect(await createIdeaWithPolicy(input())).toMatchObject({ status: 201 });
  });

  it("retries trigram matching after a transient error", async () => {
    db.$queryRaw
      .mockRejectedValueOnce(new Error("temporary database error"))
      .mockResolvedValueOnce([similarRow]);
    db.bug.findMany.mockResolvedValue([]);
    db.idea.findMany.mockResolvedValue([]);

    expect(await createIdeaWithPolicy(input())).toMatchObject({ status: 201 });
    expect(await createIdeaWithPolicy(input({ idempotencyKey: "retry-key" }))).toMatchObject({
      status: 409,
      error: "similar_issues",
    });
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(db.bug.findMany).toHaveBeenCalledTimes(1);
  });

  it("accepts acknowledgeSimilar from a query string too", () => {
    expect(isAcknowledged("true")).toBe(true);
    expect(isAcknowledged("1")).toBe(true);
    expect(isAcknowledged("false")).toBe(false);
    expect(isAcknowledged(undefined)).toBe(false);
  });
});

describe("createIdeaWithPolicy: fields (#441)", () => {
  it("inserts no type when none is given", async () => {
    await createIdeaWithPolicy(input({}));
    expect(insert.mock.calls[0][1]).toEqual({ typeId: null });
  });

  it("accepts an active type and rejects an unknown or inactive one", async () => {
    db.issueType.findUnique.mockResolvedValue({ isActive: true });
    await createIdeaWithPolicy(input({ typeId: "type-fix" }));
    expect(insert.mock.calls[0][1]).toEqual({ typeId: "type-fix" });

    db.issueType.findUnique.mockResolvedValue(null);
    expect(await createIdeaWithPolicy(input({ typeId: "nope" }))).toMatchObject({ status: 422, error: "invalid_type" });
    db.issueType.findUnique.mockResolvedValue({ isActive: false });
    expect(await createIdeaWithPolicy(input({ typeId: "retired" }))).toMatchObject({ status: 422 });
    expect(await createIdeaWithPolicy(input({ typeId: 42 }))).toMatchObject({ status: 422 });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});

describe("parseIdempotencyKey", () => {
  it("accepts UUIDs and hashes, rejects spaces, control characters and long keys", () => {
    expect(parseIdempotencyKey(" 0b6f2c1e-9d4a-4c6b-8f0e-2a7d9e1b3c55 ")).toBe("0b6f2c1e-9d4a-4c6b-8f0e-2a7d9e1b3c55");
    expect(parseIdempotencyKey("a b")).toBeNull();
    expect(parseIdempotencyKey("a\u0000b")).toBeNull();
    expect(parseIdempotencyKey("x".repeat(256))).toBeNull();
  });
});

describe("list cursor (#441)", () => {
  const rows = [
    { id: "c", createdAt: new Date("2026-10-19T10:00:00Z") },
    { id: "b", createdAt: new Date("2026-10-19T10:00:00Z") },
    { id: "a", createdAt: new Date("2026-10-19T09:00:00Z") },
  ];

  it("round-trips and rejects anything it didn't make", () => {
    const cursor = encodeCursor(rows[1]!);
    expect(decodeCursor(cursor)).toEqual(rows[1]);
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor(Buffer.from('["nope","x"]').toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from('{"id":"x"}').toString("base64url"))).toBeNull();
    expect(decodeCursor(null)).toBeNull();
  });

  it("breaks timestamp ties by id, so two issues in the same millisecond are both reached", () => {
    expect(cursorWhere(rows[0]!, "desc")).toEqual({
      OR: [
        { createdAt: { lt: rows[0]!.createdAt } },
        { createdAt: rows[0]!.createdAt, id: { lt: "c" } },
      ],
    });
    expect(cursorWhere(rows[2]!, "asc")).toEqual({
      OR: [
        { createdAt: { gt: rows[2]!.createdAt } },
        { createdAt: rows[2]!.createdAt, id: { gt: "a" } },
      ],
    });
    expect(cursorWhere(null)).toEqual({});
  });

  it("returns a next cursor only when there is another page", () => {
    const page = toPage(rows, 2);
    expect(page.items.map((r) => r.id)).toEqual(["c", "b"]);
    expect(decodeCursor(page.nextCursor)).toEqual(rows[1]);
    expect(toPage(rows, 3).nextCursor).toBeNull();
  });

  it("clamps the page size", () => {
    expect(pageSize(undefined)).toBe(25);
    expect(pageSize(null)).toBe(25);
    expect(pageSize("")).toBe(25);
    expect(pageSize("10")).toBe(10);
    // Above the maximum is clamped, not rejected, and llms.txt says so.
    expect(pageSize("5000")).toBe(100);
    expect(pageSize("100")).toBe(100);
    expect(pageSize("1")).toBe(1);
  });

  it("rejects a limit that is not a whole number in range (#454)", () => {
    // Each of these used to return the 25-item default silently.
    for (const raw of ["0", "-5", "abc", "1.5", "1e3", " 1 2 ", "+1", "٣"]) {
      expect(pageSize(raw)).toBeNull();
    }
  });
});
