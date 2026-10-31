import { describe, expect, it, vi } from "vitest";
import { pointBalance } from "./balance";

/** A ledger whose sums depend on whether the query was bounded by a period. */
function dbWith(lifetime: { points: number | null; entries: number }) {
  const isPeriod = (where: { createdAt?: unknown }) => where.createdAt !== undefined;
  return {
    pointEntry: {
      aggregate: vi.fn(async (args: { where: { createdAt?: unknown } }) => ({
        _sum: { points: isPeriod(args.where) ? 10 : lifetime.points },
      })),
      count: vi.fn(async (args: { where: { createdAt?: unknown } }) =>
        isPeriod(args.where) ? 1 : lifetime.entries,
      ),
    },
  };
}

describe("pointBalance (#618)", () => {
  it("sums every ledger row in the tenant as the lifetime balance", async () => {
    const db = dbWith({ points: 65, entries: 3 });

    const balance = await pointBalance(db as never, { tenantId: "tenant-zedu", userId: "user-1" });

    expect(balance.lifetime).toEqual({ points: 65, entries: 3, from: null, to: null });
    // No bounds given: the period is all of time, so it matches lifetime.
    expect(balance.period).toEqual({ points: 65, entries: 3, from: null, to: null });
    // One query, because an unbounded period needs no second sum.
    expect(db.pointEntry.aggregate).toHaveBeenCalledTimes(1);
    expect(db.pointEntry.aggregate.mock.calls[0][0].where).toEqual({
      tenantId: "tenant-zedu",
      userId: "user-1",
    });
  });

  it("restricts the period to the from/to bounds it was given", async () => {
    const db = dbWith({ points: 65, entries: 3 });
    const from = new Date("2026-10-01T00:00:00.000Z");
    const to = new Date("2026-10-31T23:59:59.999Z");

    const balance = await pointBalance(db as never, {
      tenantId: "tenant-zedu",
      userId: "user-1",
      from,
      to,
    });

    expect(balance.lifetime).toEqual({ points: 65, entries: 3, from: null, to: null });
    expect(balance.period).toEqual({
      points: 10,
      entries: 1,
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-31T23:59:59.999Z",
    });
    const bounded = db.pointEntry.aggregate.mock.calls
      .map((call) => call[0].where)
      .filter((where) => where.createdAt !== undefined);
    expect(bounded).toEqual([
      {
        tenantId: "tenant-zedu",
        userId: "user-1",
        createdAt: { gte: from, lte: to },
      },
    ]);
  });

  it("accepts one-sided bounds and ISO strings", async () => {
    const db = dbWith({ points: 65, entries: 3 });

    const balance = await pointBalance(db as never, {
      tenantId: "tenant-zedu",
      userId: "user-1",
      from: "2026-10-01",
    });

    expect(balance.period.from).toBe("2026-10-01T00:00:00.000Z");
    expect(balance.period.to).toBeNull();
    const bounded = db.pointEntry.count.mock.calls
      .map((call) => call[0].where)
      .filter((where) => where.createdAt !== undefined);
    expect(bounded).toEqual([
      {
        tenantId: "tenant-zedu",
        userId: "user-1",
        createdAt: { gte: new Date("2026-10-01T00:00:00.000Z") },
      },
    ]);
  });

  it("normalizes a date-only 'to' bound to end-of-day UTC", async () => {
    const db = dbWith({ points: 65, entries: 3 });

    const balance = await pointBalance(db as never, {
      tenantId: "tenant-zedu",
      userId: "user-1",
      to: "2026-10-20",
    });

    expect(balance.period.from).toBeNull();
    expect(balance.period.to).toBe("2026-10-20T23:59:59.999Z");
    const bounded = db.pointEntry.count.mock.calls
      .map((call) => call[0].where)
      .filter((where) => where.createdAt !== undefined);
    expect(bounded).toEqual([
      {
        tenantId: "tenant-zedu",
        userId: "user-1",
        createdAt: { lte: new Date("2026-10-20T23:59:59.999Z") },
      },
    ]);
  });

  it("starts at zero with no ledger rows", async () => {
    const db = dbWith({ points: null, entries: 0 });
    expect(await pointBalance(db as never, { tenantId: "t", userId: "u" })).toEqual({
      lifetime: { points: 0, entries: 0, from: null, to: null },
      period: { points: 0, entries: 0, from: null, to: null },
    });
  });

  it("rejects an unparseable bound and a backwards period", async () => {
    const db = dbWith({ points: 1, entries: 1 });
    await expect(
      pointBalance(db as never, { tenantId: "t", userId: "u", from: "yesterday" }),
    ).rejects.toThrow();
    await expect(
      pointBalance(db as never, { tenantId: "t", userId: "u", from: "1" }),
    ).rejects.toThrow();
    await expect(
      pointBalance(db as never, { tenantId: "t", userId: "u", to: "2026-02-31" }),
    ).rejects.toThrow();
    await expect(
      pointBalance(db as never, {
        tenantId: "t",
        userId: "u",
        from: new Date("2026-10-02"),
        to: new Date("2026-10-01"),
      }),
    ).rejects.toThrow();
    expect(db.pointEntry.aggregate).not.toHaveBeenCalled();
  });
});
