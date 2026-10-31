import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
  milestone: { findFirst: vi.fn(), delete: vi.fn() },
  bugActivity: { createMany: vi.fn() },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "admin-1", role: "admin" }),
  requireAdmin: vi.fn().mockResolvedValue({ id: "admin-1", role: "admin" }),
}));
vi.mock("@/lib/tenant-context", () => ({
  currentTenantIdFor: vi.fn().mockResolvedValue("tenant-ziki"),
}));
vi.mock("@/lib/prisma", () => {
  const db = {
    milestone: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    tenant: {
      findUnique: vi.fn().mockResolvedValue({ id: "tenant-ziki", name: "Ziki" }),
    },
    membership: {
      findUnique: vi.fn().mockResolvedValue({ role: "member" }),
    },
    bug: { count: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(async (run) => run(tx)),
  };
  return { prisma: db };
});

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import { revalidatePath } from "next/cache";
import {
  createMilestoneAction,
  deleteMilestoneAction,
  setMilestoneClosedAction,
  updateMilestoneAction,
} from "./milestones";

const m = prisma.milestone as unknown as Record<"findFirst" | "create" | "update" | "delete", ReturnType<typeof vi.fn>>;
const bug = prisma.bug as unknown as Record<"count" | "updateMany" | "deleteMany", ReturnType<typeof vi.fn>>;

const fd = (values: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
};

describe("milestone actions (#289)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findFirst.mockResolvedValue(null);
    tx.milestone.findFirst.mockResolvedValue({
      title: "v2.4", bugs: [{ id: "b1" }, { id: "b2" }],
    });
    tx.bugActivity.createMany.mockResolvedValue({ count: 2 });
    tx.milestone.delete.mockResolvedValue({});
  });

  it("requires an admin", async () => {
    vi.mocked(requireUser).mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(createMilestoneAction(fd({ title: "v2" }))).rejects.toThrow();
    expect(m.create).not.toHaveBeenCalled();
  });

  it("creates with a calendar due date", async () => {
    expect(await createMilestoneAction(fd({ title: " v2.4 ", dueDate: "2026-10-31", description: "" }))).toEqual({ ok: true });
    expect(m.create).toHaveBeenCalledWith({
      data: { tenantId: "tenant-ziki", title: "v2.4", description: null, dueDate: new Date("2026-10-31T00:00:00.000Z") },
    });
  });

  it("rejects a duplicate title, ignoring case", async () => {
    m.findFirst.mockResolvedValue({ title: "V2.4" });
    expect((await createMilestoneAction(fd({ title: "v2.4" }))).error).toBe('A milestone named "V2.4" already exists.');
    expect(m.create).not.toHaveBeenCalled();
  });

  it("rejects an impossible date", async () => {
    expect((await createMilestoneAction(fd({ title: "v2.4", dueDate: "2026-02-30" }))).error).toEqual(expect.any(String));
  });

  it("clears the due date when emptied", async () => {
    m.findFirst.mockImplementation(async ({ where }) => {
      if (where.id) return { id: "m1", title: "v2.4" };
      return null;
    });
    await updateMilestoneAction("m1", fd({ title: "v2.4", dueDate: "" }));
    expect(m.update.mock.calls[0][0].data.dueDate).toBeNull();
  });

  it("closing touches only the milestone", async () => {
    m.findFirst.mockResolvedValue({ id: "m1", title: "v2.4" });
    expect(await setMilestoneClosedAction("m1", true)).toEqual({ ok: true });
    expect(m.update).toHaveBeenCalledWith({ where: { id: "m1" }, data: { isClosed: true, closedAt: expect.any(Date) } });
    expect(bug.updateMany).not.toHaveBeenCalled();
  });

  it("deleting leaves the issues to the database's SET NULL and reports how many", async () => {
    expect(await deleteMilestoneAction("m1")).toEqual({ ok: true, cleared: 2 });
    expect(tx.milestone.delete).toHaveBeenCalledWith({ where: { id: "m1" } });
    expect(tx.bugActivity.createMany).toHaveBeenCalledWith({ data: ["b1", "b2"].map((bugId) => ({
      bugId, actorId: "admin-1", type: "milestone_changed",
      summary: 'removed this from milestone "v2.4"',
      metadata: { field: "milestone", from: "v2.4", to: null },
    })) });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(m.delete).not.toHaveBeenCalled();
    expect(bug.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes an empty milestone without creating empty activities", async () => {
    tx.milestone.findFirst.mockResolvedValue({ title: "Empty", bugs: [] });
    expect(await deleteMilestoneAction("m1")).toEqual({ ok: true, cleared: 0 });
    expect(tx.bugActivity.createMany).not.toHaveBeenCalled();
    expect(tx.milestone.delete).toHaveBeenCalled();
  });

  it("does not delete the milestone or revalidate if history fails", async () => {
    tx.bugActivity.createMany.mockRejectedValueOnce(new Error("history failed"));
    await expect(deleteMilestoneAction("m1")).rejects.toThrow("history failed");
    expect(tx.milestone.delete).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("requires an admin before starting deletion", async () => {
    vi.mocked(requireUser).mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(deleteMilestoneAction("m1")).rejects.toThrow("NEXT_REDIRECT");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("says so when the milestone is already gone", async () => {
    tx.milestone.findFirst.mockResolvedValue(null);
    expect((await deleteMilestoneAction("m1")).error).toEqual(expect.any(String));
    expect(tx.bugActivity.createMany).not.toHaveBeenCalled();
  });
});
