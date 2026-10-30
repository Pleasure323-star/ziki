import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), unstable_cache: vi.fn((fn) => fn) }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/tenant-context", () => ({
  currentTenantIdFor: vi.fn(),
  NO_TENANT_MESSAGE: "You're not a member of a workspace yet, so you can't file issues here.",
}));
vi.mock("@/lib/agents/membership", () => ({ isTenantAdmin: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    pointDispute: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    pointEntry: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), createMany: vi.fn() },
    bug: { findUnique: vi.fn(), findFirst: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import { currentTenantIdFor } from "@/lib/tenant-context";
import { isTenantAdmin } from "@/lib/agents/membership";
import { openDisputeAction, resolveDisputeAction } from "./actions";

type Mock = ReturnType<typeof vi.fn>;
const p = prisma as unknown as {
  pointDispute: Record<"findUnique" | "findMany" | "update" | "create", Mock>;
  pointEntry: Record<"findUnique" | "findMany" | "update" | "createMany", Mock>;
  bug: Record<"findFirst" | "findUnique", Mock>;
};

const user = { id: "user-1", role: "user" as const };
const admin = { id: "admin-1", role: "admin" as const };

const fd = (values: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
};

const openDisputeRow = {
  id: "dispute-1",
  tenantId: "tenant-1",
  userId: "user-1",
  bugId: "bug-1",
  pointEntryId: null as string | null,
  status: "open" as const,
};

describe("openDisputeAction (#436)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUser).mockResolvedValue(user);
    vi.mocked(currentTenantIdFor).mockResolvedValue("tenant-1");
    p.bug.findFirst.mockResolvedValue({ id: "bug-1" });
    p.pointDispute.create.mockResolvedValue({ id: "dispute-1" });
  });

  it("refuses someone with no workspace", async () => {
    vi.mocked(currentTenantIdFor).mockResolvedValue(null);
    const result = await openDisputeAction(
      undefined,
      fd({ bugNumber: "42", kind: "missing", role: "solver", reason: "Missing award." }),
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining("workspace") });
    expect(p.pointDispute.create).not.toHaveBeenCalled();
  });

  it("reports the field that failed validation", async () => {
    const result = await openDisputeAction(
      undefined,
      fd({ bugNumber: "0", kind: "missing", role: "solver", reason: "Missing award." }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("bugNumber");
  });

  it("opens the dispute and revalidates the page", async () => {
    const { revalidatePath } = await import("next/cache");
    const result = await openDisputeAction(
      undefined,
      fd({ bugNumber: "42", kind: "missing", role: "solver", reason: "I resolved it, no points." }),
    );
    expect(result.ok).toBe(true);
    expect(p.pointDispute.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: "tenant-1", userId: "user-1", bugId: "bug-1" }),
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/points/disputes");
  });

  it("surfaces another workspace's bug as not found", async () => {
    p.bug.findFirst.mockResolvedValue(null);
    const result = await openDisputeAction(
      undefined,
      fd({ bugNumber: "99", kind: "missing", role: "solver", reason: "Not my workspace." }),
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining("isn't in this workspace") });
  });
});

describe("resolveDisputeAction (#436)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUser).mockResolvedValue(admin);
    vi.mocked(currentTenantIdFor).mockResolvedValue("tenant-1");
    vi.mocked(isTenantAdmin).mockResolvedValue(true);
    p.pointDispute.findUnique.mockResolvedValue(openDisputeRow);
    p.bug.findUnique.mockResolvedValue({
      id: "bug-1",
      number: 42,
      tenantId: "tenant-1",
      reporterId: "user-1",
      assigneeId: "user-2",
    });
    p.pointEntry.createMany.mockResolvedValue({ count: 1 });
    p.pointDispute.update.mockResolvedValue({});
  });

  it("refuses a non-admin", async () => {
    vi.mocked(requireUser).mockResolvedValue(user);
    vi.mocked(isTenantAdmin).mockResolvedValue(false);
    const result = await resolveDisputeAction(
      undefined,
      fd({ disputeId: "dispute-1", decision: "grant", role: "solver" }),
    );
    expect(result).toEqual({ ok: false, error: "Only a workspace admin can resolve disputes." });
    expect(p.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("refuses a dispute from another workspace", async () => {
    vi.mocked(currentTenantIdFor).mockResolvedValue("tenant-2");
    const result = await resolveDisputeAction(
      undefined,
      fd({ disputeId: "dispute-1", decision: "reject" }),
    );
    expect(result).toEqual({ ok: false, error: expect.stringContaining("isn't in this workspace") });
  });

  it("grants the missing solver award with the canonical ledger entry", async () => {
    const result = await resolveDisputeAction(
      undefined,
      fd({ disputeId: "dispute-1", decision: "grant", role: "solver" }),
    );
    expect(result).toEqual({ ok: true, message: "Granted the missing solver award." });
    expect(p.pointEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            userId: "user-2",
            role: "solver",
            points: 750,
            sourceKey: "solver:bug-1:user-2",
          }),
        ],
      }),
    );
    expect(p.pointDispute.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "dispute-1" },
        data: expect.objectContaining({ status: "granted", resolvedById: "admin-1" }),
      }),
    );
  });

  it("says so when the award was already in the ledger", async () => {
    p.pointEntry.createMany.mockResolvedValue({ count: 0 });
    const result = await resolveDisputeAction(
      undefined,
      fd({ disputeId: "dispute-1", decision: "grant", role: "solver" }),
    );
    expect(result).toEqual({
      ok: true,
      message: "That award was already in the ledger, so nothing was added twice.",
    });
  });

  it("corrects a wrong entry with a reversing row", async () => {
    p.pointDispute.findUnique.mockResolvedValue({
      ...openDisputeRow,
      pointEntryId: "entry-1",
    });
    p.pointEntry.findUnique.mockResolvedValue({
      id: "entry-1",
      tenantId: "tenant-1",
      userId: "user-1",
      bugId: "bug-1",
      role: "solver",
      points: 25,
    });
    p.pointEntry.update.mockResolvedValue({});
    const result = await resolveDisputeAction(
      undefined,
      fd({ disputeId: "dispute-1", decision: "correct", note: "High, not medium." }),
    );
    expect(result.ok).toBe(true);
    expect(p.pointEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { correctedAt: expect.any(Date) } }),
    );
    expect(p.pointEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ points: -25, sourceKey: "undo:entry-1" })],
      }),
    );
  });

  it("rejects without touching the ledger", async () => {
    const result = await resolveDisputeAction(
      undefined,
      fd({ disputeId: "dispute-1", decision: "reject", note: "Already awarded." }),
    );
    expect(result).toEqual({ ok: true, message: "Dispute rejected." });
    expect(p.pointEntry.createMany).not.toHaveBeenCalled();
    expect(p.pointDispute.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "rejected", resolution: "Already awarded." }),
      }),
    );
  });

  it("refuses a decision that isn't one of the three", async () => {
    const result = await resolveDisputeAction(
      undefined,
      fd({ disputeId: "dispute-1", decision: "teleport" }),
    );
    expect(result).toEqual({ ok: false, error: "Unknown decision." });
  });
});
