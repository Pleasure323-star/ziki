import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor: vi.fn(async () => "tenant-zedu"),
}));
vi.mock("@/lib/project-context", () => ({
  activeProjectIdFor: vi.fn(async () => "project-zedu"),
}));
import { NextRequest } from "next/server";

vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  consumeRateLimit: vi.fn(),
  RATE_LIMIT_MESSAGE: "slow down",
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { bug: { findMany: vi.fn() } },
}));

import { resolveSessionUserId } from "@/lib/session-user";
import { consumeRateLimit } from "@/lib/rate-limit";
import { currentTenantIdFor } from "@/lib/tenant-context";
import { activeProjectIdFor } from "@/lib/project-context";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const session = vi.mocked(resolveSessionUserId) as unknown as ReturnType<typeof vi.fn>;
const limit = vi.mocked(consumeRateLimit) as unknown as ReturnType<typeof vi.fn>;
const tenant = vi.mocked(currentTenantIdFor) as unknown as ReturnType<typeof vi.fn>;
const project = vi.mocked(activeProjectIdFor) as unknown as ReturnType<typeof vi.fn>;
const findMany = vi.mocked(prisma.bug.findMany) as unknown as ReturnType<typeof vi.fn>;

const get = (q: string) =>
  GET(new NextRequest(`http://x/api/issues/suggest?q=${encodeURIComponent(q)}`));

describe("GET /api/issues/suggest (#671)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.mockResolvedValue({ userId: "u1" });
    limit.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
    tenant.mockResolvedValue("tenant-zedu");
    project.mockResolvedValue("project-zedu");
    findMany.mockResolvedValue([]);
  });

  it("requires a session", async () => {
    session.mockResolvedValue({ error: "no" });
    expect((await get("login")).status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("is rate limited per user", async () => {
    limit.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    expect((await get("login")).status).toBe(429);
    expect(limit).toHaveBeenCalledWith("suggest:u1", expect.any(Object));
    expect(findMany).not.toHaveBeenCalled();
  });

  it("doesn't query for a one-character search", async () => {
    const body = await (await get("l")).json();
    expect(body).toEqual({ issues: [] });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("searches the tenant's active project for title matches", async () => {
    findMany.mockResolvedValue([
      { id: "i1", number: 4, title: "Login button broken", status: "open", project: { slug: "ziki" } },
    ]);
    const body = await (await get("login")).json();

    expect(body.issues).toEqual([
      { id: "i1", number: 4, title: "Login button broken", status: "open", path: "/ziki/4" },
    ]);
    const where = findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe("tenant-zedu");
    expect(where.projectId).toBe("project-zedu");
    expect(where.isDeleted).toBe(false);
    expect(where.OR).toEqual([
      { title: { contains: "login", mode: "insensitive" } },
    ]);
  });

  it("also suggests the issue number when the query is one", async () => {
    await get("#42");
    expect(findMany.mock.calls[0][0].where.OR).toEqual([
      { title: { contains: "#42", mode: "insensitive" } },
      { number: 42 },
    ]);
  });

  it("returns nothing when the user has no tenant", async () => {
    tenant.mockResolvedValue(null);
    const body = await (await get("login")).json();
    expect(body).toEqual({ issues: [] });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("fails softly when the query fails", async () => {
    findMany.mockRejectedValue(new Error("db down"));
    const res = await get("login");
    expect(res.status).toBe(500);
  });
});
