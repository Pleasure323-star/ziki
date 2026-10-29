import { beforeEach, describe, expect, it, vi } from "vitest";

// #425: run as a member of the Zedu tenant.
vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor: vi.fn(async () => "tenant-zedu"),
  defaultProjectIdFor: vi.fn(async () => "project-zedu"),
  tenantIdForUser: vi.fn(async () => "tenant-zedu"),
}));
import { NextRequest } from "next/server";

vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(),
  RATE_LIMIT_MESSAGE: "slow down",
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: vi.fn(), bug: { findMany: vi.fn() } },
}));

import { resolveSessionUserId } from "@/lib/session-user";
import { consumeRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const session = vi.mocked(resolveSessionUserId) as unknown as ReturnType<typeof vi.fn>;
const limit = vi.mocked(consumeRateLimit) as unknown as ReturnType<typeof vi.fn>;
const raw = vi.mocked(prisma.$queryRaw) as unknown as ReturnType<typeof vi.fn>;
const findMany = vi.mocked(prisma.bug.findMany) as unknown as ReturnType<typeof vi.fn>;

const get = (q: string) => GET(new NextRequest(`http://x/api/issues/similar?q=${encodeURIComponent(q)}`));

describe("GET /api/issues/similar (#284)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.mockResolvedValue({ userId: "u1" });
    limit.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
  });

  it("requires a session", async () => {
    session.mockResolvedValue({ error: "no" });
    expect((await get("Login button broken")).status).toBe(401);
    expect(raw).not.toHaveBeenCalled();
  });

  it("is rate limited per user", async () => {
    limit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    expect((await get("Login button broken")).status).toBe(429);
    expect(limit).toHaveBeenCalledWith("similar:u1", expect.any(Object));
  });

  it("doesn't query for a short title", async () => {
    const res = await get("Login");
    expect(await res.json()).toEqual({ issues: [] });
    expect(raw).not.toHaveBeenCalled();
  });

  it("returns the strong matches only, from open issues, excluding deleted", async () => {
    raw.mockResolvedValue([
      { id: "a", number: 4, title: "Login button broken", status: "open", voteCount: 2, score: 0.9 },
      { id: "b", number: 9, title: "Logo is blurry", status: "open", voteCount: 0, score: 0.2 },
    ]);
    const body = await (await get("Login button is broken")).json();
    expect(body.issues.map((i: { id: string }) => i.id)).toEqual(["a"]);
    const sql = (raw.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toContain('"isDeleted" = false');
    expect(sql).toContain('"status"::text = ANY');
    expect(raw.mock.calls[0]).toContainEqual(["requires_confirmation", "open", "in_progress"]);
  });

  it("falls back to word matching when pg_trgm is missing", async () => {
    raw.mockRejectedValue(new Error('operator does not exist: text % text'));
    findMany.mockResolvedValue([{ id: "c", number: 2, title: "Login button broken", status: "open", voteCount: 1 }]);
    const body = await (await get("Login button broken")).json();
    expect(body.issues).toHaveLength(1);
    expect(findMany.mock.calls[0][0].where.isDeleted).toBe(false);
    // #425: only the searcher's tenant.
    expect(findMany.mock.calls[0][0].where.tenantId).toBe("tenant-zedu");
  });

  it("retries trigram matching after a transient error", async () => {
    raw
      .mockRejectedValueOnce(new Error("temporary database error"))
      .mockResolvedValueOnce([
        { id: "e", number: 6, title: "Login button broken", status: "open", voteCount: 1, score: 0.9 },
      ]);
    findMany.mockResolvedValue([]);

    expect(await (await get("Login button broken")).json()).toEqual({ issues: [] });
    const recovered = await (await get("Login button broken")).json();

    expect(recovered.issues.map((issue: { id: string }) => issue.id)).toEqual(["e"]);
    expect(raw).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("supports single-term fallback queries meeting the length threshold", async () => {
    raw.mockRejectedValue(new Error('operator does not exist: text % text'));
    findMany.mockResolvedValue([{ id: "d", number: 5, title: "Authentication fails silently", status: "open", voteCount: 3 }]);
    const body = await (await get("Authentication")).json();
    expect(body.issues).toHaveLength(1);
    expect(findMany.mock.calls[0][0].where.AND).toEqual([
      { title: { contains: "authentication", mode: "insensitive" } },
    ]);
  });
});
