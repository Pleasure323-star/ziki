import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  agentApiKey: { findUnique: vi.fn() },
  agentAuditEvent: { create: vi.fn() },
  pointEntry: { aggregate: vi.fn(), count: vi.fn() },
}));
const budget = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agents/rate-budget", async (original) => ({
  ...await original<typeof import("@/lib/agents/rate-budget")>(),
  consumeAgentBudget: budget,
}));

import { GET } from "./route";

function key(level = "working") {
  return {
    id: "key-a",
    revokedAt: null,
    agent: {
      id: "agent-a",
      name: "Ada's Claude",
      ownerUserId: "ada",
      tenantId: "tenant-zedu",
      level,
      burst: false,
      revokedAt: null,
      owner: { memberships: [{ tenantId: "tenant-zedu" }] },
    },
  };
}

function request(query = "", hasKey = true) {
  return new NextRequest(`http://localhost/api/v1/agents/me/points${query}`, {
    headers: { ...(hasKey ? { authorization: "Bearer ziki_test-key" } : {}) },
  });
}

/** Sums that differ when the query carries a period, so the two are tellable apart. */
const isPeriod = (where: { createdAt?: unknown }) => where.createdAt !== undefined;

beforeEach(() => {
  vi.resetAllMocks();
  db.agentApiKey.findUnique.mockResolvedValue(key());
  budget.mockResolvedValue({ allowed: true });
  db.pointEntry.aggregate.mockImplementation(async (args: { where: { createdAt?: unknown } }) => ({
    _sum: { points: isPeriod(args.where) ? 10 : 65 },
  }));
  db.pointEntry.count.mockImplementation(async (args: { where: { createdAt?: unknown } }) =>
    isPeriod(args.where) ? 1 : 3,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/v1/agents/me/points (#618)", () => {
  it("rejects a missing or invalid key", async () => {
    expect((await GET(request("", false))).status).toBe(401);
    db.agentApiKey.findUnique.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(401);
    expect(db.pointEntry.aggregate).not.toHaveBeenCalled();
  });

  it("returns the owner's balance in the agent's tenant, charged as a read and audited", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      user_id: "ada",
      tenant_id: "tenant-zedu",
      lifetime: { points: 65, entries: 3, from: null, to: null },
      period: { points: 65, entries: 3, from: null, to: null },
    });
    // The person comes from the agent row, and the sum is scoped to its tenant.
    expect(db.pointEntry.aggregate.mock.calls[0][0].where).toEqual({
      tenantId: "tenant-zedu",
      userId: "ada",
    });
    expect(budget).toHaveBeenCalledWith({ id: "agent-a", burst: false, burstUntil: null }, "read");
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "points.balance", tenantId: "tenant-zedu" }),
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("bounds the period with from/to and leaves lifetime alone", async () => {
    const response = await GET(request("?from=2026-10-01&to=2026-10-31T23:59:59.999Z"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lifetime).toEqual({ points: 65, entries: 3, from: null, to: null });
    expect(body.period).toEqual({
      points: 10,
      entries: 1,
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-31T23:59:59.999Z",
    });
    const bounded = db.pointEntry.aggregate.mock.calls
      .map((call) => call[0].where)
      .filter((where) => where.createdAt !== undefined);
    expect(bounded).toHaveLength(1);
    expect(bounded[0].createdAt).toEqual({
      gte: new Date("2026-10-01T00:00:00.000Z"),
      lte: new Date("2026-10-31T23:59:59.999Z"),
    });
  });

  it("normalizes a date-only 'to' bound to include the entire UTC day (#503)", async () => {
    const response = await GET(request("?from=2026-10-01&to=2026-10-20"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.period).toEqual({
      points: 10,
      entries: 1,
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-20T23:59:59.999Z",
    });

    const bounded = db.pointEntry.aggregate.mock.calls
      .map((call) => call[0].where)
      .filter((where) => where.createdAt !== undefined);
    expect(bounded).toHaveLength(1);
    const upperLimit = bounded[0].createdAt.lte as Date;
    expect(upperLimit).toEqual(new Date("2026-10-20T23:59:59.999Z"));

    // Verify an entry written late on the 'to' day falls within the query bound
    const lateDayEntryTime = new Date("2026-10-20T23:59:00.000Z");
    expect(lateDayEntryTime.getTime()).toBeLessThanOrEqual(upperLimit.getTime());
  });

  it("never exposes the wallet address to an agent", async () => {
    const body = await (await GET(request())).json();
    expect(JSON.stringify(body)).not.toContain("wallet");
  });

  it("refuses a malformed, non-ISO, or backwards period before touching the ledger (#503)", async () => {
    for (const query of [
      "?from=yesterday",
      "?from=",
      "?from=1",
      "?to=1",
      "?from=2026-13-40",
      "?to=2026-02-31",
      "?from=2026-10-02&to=2026-10-01",
    ]) {
      const res = await GET(request(query));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toEqual(expect.any(String));
    }
    expect(db.pointEntry.aggregate).not.toHaveBeenCalled();
  });

  it("does not call the ledger when the read budget is used up", async () => {
    budget.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 });
    const response = await GET(request());
    expect(response.status).toBe(429);
    expect(db.pointEntry.aggregate).not.toHaveBeenCalled();
  });
});
