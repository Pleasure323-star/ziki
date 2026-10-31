import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  pointEntry: { groupBy: vi.fn() },
  user: { findMany: vi.fn() },
}));
const requireUser = vi.hoisted(() => vi.fn());
const tenantIdFor = vi.hoisted(() => vi.fn());
const tenantAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser }));
vi.mock("@/lib/tenant-context", () => ({ currentTenantIdFor: tenantIdFor }));
vi.mock("@/lib/agents/membership", () => ({ isTenantAdmin: tenantAdmin }));

import { exportPointsSnapshotAction } from "./points-export";

const form = (cutoff?: string) => {
  const data = new FormData();
  if (cutoff !== undefined) data.set("cutoff", cutoff);
  return data;
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("POINTS_EXPORT_SECRET", "local-export-secret");
  requireUser.mockResolvedValue({ id: "admin-1", role: "user" });
  tenantIdFor.mockResolvedValue("tenant-zedu");
  tenantAdmin.mockResolvedValue(true);
  db.pointEntry.groupBy.mockResolvedValue([
    { userId: "u_ada", _sum: { points: 65 }, _count: { _all: 3 } },
    { userId: "u_bola", _sum: { points: 40 }, _count: { _all: 2 } },
  ]);
  db.user.findMany.mockResolvedValue([
    { id: "u_ada", name: "Ada", walletAddress: "0x" + "a".repeat(40) },
    { id: "u_bola", name: "Bola", walletAddress: null },
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("exportPointsSnapshotAction (#618)", () => {
  it("exports only for a workspace admin, scoped to their own workspace", async () => {
    const result = await exportPointsSnapshotAction(undefined, form("2026-10-20T00:00:00.000Z"));

    expect(result.ok).toBe(true);
    expect(db.pointEntry.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: "tenant-zedu", createdAt: { lte: new Date("2026-10-20T00:00:00.000Z") } },
      }),
    );
    const json = JSON.parse((result as { json: string }).json);
    expect(json.rows.map((row: { userId: string }) => row.userId)).toEqual(["u_ada", "u_bola"]);
    expect(json.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect((result as { csv: string }).csv).toContain("user_id,name,points,entries,wallet_address");
  });

  it("refuses everyone who is not an admin of that workspace", async () => {
    tenantAdmin.mockResolvedValue(false);
    const result = await exportPointsSnapshotAction(undefined, form("2026-10-20"));
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(db.pointEntry.groupBy).not.toHaveBeenCalled();
  });

  it("refuses someone with no workspace", async () => {
    tenantIdFor.mockResolvedValue(null);
    const result = await exportPointsSnapshotAction(undefined, form("2026-10-20"));
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(db.pointEntry.groupBy).not.toHaveBeenCalled();
  });

  it("produces the same hash for the same cutoff, and a different one for a later cutoff", async () => {
    const first = await exportPointsSnapshotAction(undefined, form("2026-10-20T00:00:00.000Z"));
    const again = await exportPointsSnapshotAction(undefined, form("2026-10-20T00:00:00.000Z"));
    const later = await exportPointsSnapshotAction(undefined, form("2026-10-21T00:00:00.000Z"));

    expect(first.ok && again.ok && later.ok).toBe(true);
    const [a, b, c] = [first, again, later] as Array<{ hash: string; json: string; signature: string }>;
    expect(a.hash).toBe(b.hash);
    expect(a.json).toBe(b.json);
    expect(a.signature).toBe(b.signature);
    expect(a.hash).not.toBe(c.hash);
    expect(JSON.parse(a.json).contentHash).toBe(a.hash);
  });

  it("rejects a cutoff that is not a date", async () => {
    const result = await exportPointsSnapshotAction(undefined, form("last tuesday"));
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(db.pointEntry.groupBy).not.toHaveBeenCalled();
  });

  it("defaults a blank cutoff to now", async () => {
    const result = await exportPointsSnapshotAction(undefined, form(""));
    expect(result.ok).toBe(true);
    expect((result as { cutoff: string }).cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses to sign when POINTS_EXPORT_SECRET is unset", async () => {
    vi.stubEnv("POINTS_EXPORT_SECRET", "");
    const result = await exportPointsSnapshotAction(undefined, form("2026-10-20"));
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("POINTS_EXPORT_SECRET");
    expect(db.pointEntry.groupBy).not.toHaveBeenCalled();
  });
});
