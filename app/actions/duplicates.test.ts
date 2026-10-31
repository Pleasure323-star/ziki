import { beforeEach, describe, expect, it, vi } from "vitest";

// #425: run as a member of the Zedu tenant.
vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor: vi.fn(async () => "tenant-zedu"),
  defaultProjectIdFor: vi.fn(async () => "project-zedu"),
  tenantIdForUser: vi.fn(async () => "tenant-zedu"),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "admin-1", role: "user" }),
}));

vi.mock("@/lib/tenant-access", () => ({
  currentTenantAccess: vi.fn(async () => ({
    tenantId: "tenant-zedu",
    tenantName: "Zedu",
    tenantSlug: "zedu",
    membershipRole: "admin",
    admin: true,
  })),
}));

const tx = {
  $queryRaw: vi.fn(),
  bug: { count: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  bugActivity: { createMany: vi.fn() },
};
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bug: { findUnique: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  },
}));

import { prisma } from "@/lib/prisma";
import { clearDuplicateAction, markDuplicateAction } from "./duplicates";

const findUnique = vi.mocked(prisma.bug.findUnique) as unknown as ReturnType<typeof vi.fn>;
const row = (id: string, number: number, duplicateOfId: string | null = null, isDeleted = false) => ({
  id,
  number,
  duplicateOfId,
  isDeleted,
});

describe("markDuplicateAction (#285)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUnique.mockResolvedValue({ id: "b" });
    tx.bug.count.mockResolvedValue(0);
  });

  it("asks for an issue number when the input isn't one", async () => {
    expect(await markDuplicateAction("a", "login bug")).toEqual({ error: expect.any(String) });
  });

  it("links the issue and records it on both sides", async () => {
    tx.$queryRaw.mockResolvedValue([row("a", 1), row("b", 2)]);
    expect(await markDuplicateAction("a", "#2")).toEqual({ ok: true });
    expect(findUnique).toHaveBeenCalledWith({
      where: { tenantId_number: { tenantId: "tenant-zedu", number: 2 } },
      select: { id: true },
    });
    expect(tx.bug.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { duplicateOfId: "b" } });
    const activities = tx.bugActivity.createMany.mock.calls[0][0].data;
    expect(activities.map((x: { bugId: string; summary: string }) => [x.bugId, x.summary])).toEqual([
      ["a", "marked this as a duplicate of #2"],
      ["b", "marked #1 as a duplicate of this issue"],
    ]);
  });

  it("refuses a self link", async () => {
    findUnique.mockResolvedValue({ id: "a" });
    tx.$queryRaw.mockResolvedValue([row("a", 1)]);
    expect((await markDuplicateAction("a", "#1")).error).toMatch(/itself/);
    expect(tx.bug.update).not.toHaveBeenCalled();
  });

  it("refuses a chain through a target that is a duplicate", async () => {
    tx.$queryRaw.mockResolvedValue([row("a", 1), row("b", 2, "c")]);
    tx.bug.findUnique.mockResolvedValue({ number: 3 });
    expect((await markDuplicateAction("a", "#2")).error).toBe(
      "#2 is itself a duplicate. Mark this one a duplicate of #3 instead.",
    );
    expect(tx.bug.update).not.toHaveBeenCalled();
  });

  it("refuses a chain through an issue that has duplicates", async () => {
    tx.$queryRaw.mockResolvedValue([row("a", 1), row("b", 2)]);
    tx.bug.count.mockResolvedValue(1);
    expect((await markDuplicateAction("a", "#2")).error).toEqual(expect.any(String));
    expect(tx.bug.update).not.toHaveBeenCalled();
  });

  it("locks both rows before checking", async () => {
    tx.$queryRaw.mockResolvedValue([row("a", 1), row("b", 2)]);
    await markDuplicateAction("a", "#2");
    const sql = (tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toMatch(/FOR UPDATE/);
  });

  it("does nothing when already linked to that issue", async () => {
    tx.$queryRaw.mockResolvedValue([row("a", 1, "b"), row("b", 2)]);
    expect(await markDuplicateAction("a", "#2")).toEqual({ ok: true });
    expect(tx.bug.update).not.toHaveBeenCalled();
  });
});

describe("clearDuplicateAction (#285)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clears the link and records it on both sides", async () => {
    findUnique.mockResolvedValue({ number: 1, duplicateOfId: "b", duplicateOf: { id: "b", number: 2 } });
    tx.bug.updateMany.mockResolvedValue({ count: 1 });
    expect(await clearDuplicateAction("a")).toEqual({ ok: true });
    expect(tx.bug.updateMany).toHaveBeenCalledWith({
      where: { id: "a", duplicateOfId: "b" },
      data: { duplicateOfId: null },
    });
    expect(tx.bugActivity.createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  it("is a no-op for an issue that isn't a duplicate", async () => {
    findUnique.mockResolvedValue({ number: 1, duplicateOfId: null, duplicateOf: null });
    expect(await clearDuplicateAction("a")).toEqual({ ok: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
