import { TICKET_TRIAGE_ERRORS } from "@/lib/ticket-triage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationEvent } from "@/lib/notifications";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), access: vi.fn(), notifyLater: vi.fn(), awardSolver: vi.fn(),
  db: { bug: { findMany: vi.fn() }, user: { findFirst: vi.fn() }, $transaction: vi.fn() },
  tx: {
    bug: { updateMany: vi.fn() }, bugActivity: { createMany: vi.fn() },
    issueWatch: { createMany: vi.fn() }, issueClaim: { updateMany: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/tenant-access", () => ({ currentTenantAccess: mocks.access }));
vi.mock("@/lib/tenant-context", () => ({
  currentTenantIdFor: async () => "tenant-1",
  bugInTenant: () => ({ tenantId: "tenant-1" }),
}));
vi.mock("@/lib/notify", () => ({ notifyLater: mocks.notifyLater }));
vi.mock("@/lib/points/award", () => ({ awardSolver: mocks.awardSolver }));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  unstable_cache: (fn: (...a: unknown[]) => unknown) => fn,
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error(`redirect:${path}`); },
}));

import { bulkUpdateBugsAction } from "./issues-bulk";
import { resolveWatchers } from "@/lib/watch";

function bug(id: string, overrides: Partial<{ status: string; assigneeId: string | null; isDeleted: boolean }> = {}) {
  return {
    id, tenantId: "tenant-1", title: `Issue ${id}`, reporterId: `reporter-${id}`,
    status: "open", severity: "medium", assigneeId: "old-assignee", isDeleted: false,
    typeId: null, categoryId: null, type: null, category: null, assignee: { name: "Old assignee" },
    ...overrides,
  };
}

type SavedWatch = { bugId: string; userId: string; watching: boolean };
const watches = new Map<string, SavedWatch>();
const order: string[] = [];
let rows: ReturnType<typeof bug>[];
const actor = { actorId: "admin-1", actorName: "Ada Admin" };
const events = () => mocks.notifyLater.mock.calls.flat() as NotificationEvent[];

beforeEach(() => {
  vi.resetAllMocks();
  watches.clear();
  order.length = 0;
  rows = [bug("b1")];
  mocks.requireUser.mockResolvedValue({ id: actor.actorId, name: actor.actorName, role: "admin" });
  mocks.access.mockResolvedValue({ admin: true });
  // Respect the select so missing notification context cannot pass unnoticed.
  mocks.db.bug.findMany.mockImplementation(async ({ select }) => rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => select[key])),
  ));
  mocks.db.user.findFirst.mockResolvedValue({ id: "new-assignee", name: "New assignee" });
  mocks.tx.bug.updateMany.mockImplementation(async ({ where }) => ({ count: where.id.in.length }));
  mocks.tx.bugActivity.createMany.mockResolvedValue({ count: 1 });
  mocks.tx.issueClaim.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.issueWatch.createMany.mockImplementation(async ({ data, skipDuplicates }: { data: SavedWatch[]; skipDuplicates: boolean }) => {
    let count = 0;
    for (const row of data) {
      const key = `${row.bugId}:${row.userId}`;
      if (skipDuplicates && watches.has(key)) continue;
      watches.set(key, row);
      count++;
    }
    return { count };
  });
  mocks.db.$transaction.mockImplementation(async (run) => {
    const result = await run(mocks.tx);
    order.push("commit");
    return result;
  });
  mocks.notifyLater.mockImplementation(() => { order.push("notify"); });
});

afterEach(() => vi.restoreAllMocks());

describe("bulk notification and watch parity (#717)", () => {
  it("watches new assignments transactionally and queues one event per changed row after commit", async () => {
    rows = [bug("b1"), bug("b2", { assigneeId: "other-assignee" }), bug("b3", { assigneeId: "new-assignee" })];
    expect(await bulkUpdateBugsAction(["b1", "b2", "b3", "b1"], { assigneeId: "new-assignee" })).toMatchObject({ ok: true, updated: 2 });
    expect([...watches.values()]).toEqual([
      { bugId: "b1", userId: "new-assignee", watching: true },
      { bugId: "b2", userId: "new-assignee", watching: true },
    ]);
    expect(events()).toEqual([
      { ...actor, bugId: "b1", bugTitle: "Issue b1", kind: "assignee_changed", fromUserId: "old-assignee", toUserId: "new-assignee" },
      { ...actor, bugId: "b2", bugTitle: "Issue b2", kind: "assignee_changed", fromUserId: "other-assignee", toUserId: "new-assignee" },
    ]);
    expect(mocks.notifyLater).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["commit", "notify"]);
  });

  it("refuses a bulk status change: nobody sets a status by hand (Ziki #713)", async () => {
    rows = [bug("b1"), bug("b2", { status: "in_progress" })];
    expect(await bulkUpdateBugsAction(["b1", "b2"], { status: "in_progress" })).toEqual({
      error: TICKET_TRIAGE_ERRORS.statusUnauthorized,
    });
    expect(await bulkUpdateBugsAction(["b1"], { assigneeId: "new-assignee", status: "resolved" })).toEqual({
      error: TICKET_TRIAGE_ERRORS.statusUnauthorized,
    });
    expect(events()).toEqual([]);
    expect(mocks.tx.issueClaim.updateMany).not.toHaveBeenCalled();
    expect(mocks.awardSolver).not.toHaveBeenCalled();
  });

  it("keeps the assignee's durable watch after a later unassignment", async () => {
    await bulkUpdateBugsAction(["b1"], { assigneeId: "new-assignee" });
    rows = [bug("b1", { assigneeId: "new-assignee" })];
    expect(await bulkUpdateBugsAction(["b1"], { assigneeId: "" })).toMatchObject({ ok: true, updated: 1 });
    expect(mocks.tx.issueWatch.createMany).toHaveBeenCalledTimes(1);
    expect(resolveWatchers(["reporter-b1", null], [...watches.values()])).toContain("new-assignee");
    expect(events().at(-1)).toMatchObject({ kind: "assignee_changed", fromUserId: "new-assignee", toUserId: null });
  });

  it("preserves an explicit unwatch when a person is assigned", async () => {
    watches.set("b1:new-assignee", { bugId: "b1", userId: "new-assignee", watching: false });
    expect(await bulkUpdateBugsAction(["b1"], { assigneeId: "new-assignee" })).toMatchObject({ ok: true });
    expect(watches.get("b1:new-assignee")?.watching).toBe(false);
    expect(mocks.tx.issueWatch.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
  });

  it("does not watch or notify skipped deleted and missing issues", async () => {
    rows = [bug("b1"), bug("b2", { isDeleted: true })];
    const result = await bulkUpdateBugsAction(["b1", "b2", "missing"], { assigneeId: "new-assignee" });
    expect(result).toMatchObject({ ok: true, updated: 1, skipped: [{ id: "b2" }, { id: "missing" }] });
    expect(events().map((event) => event.bugId)).toEqual(["b1"]);
    expect([...watches.values()].map((row) => row.bugId)).toEqual(["b1"]);
  });

  it("does not write watches or queue events for an unchanged batch", async () => {
    rows = [bug("b1", { assigneeId: "new-assignee", status: "in_progress" })];
    expect(await bulkUpdateBugsAction(["b1"], { assigneeId: "new-assignee" })).toEqual({ ok: true, updated: 0, skipped: [] });
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
    expect(mocks.notifyLater).not.toHaveBeenCalled();
  });

  it("does not create assignment/status side effects for a severity-only change", async () => {
    expect(await bulkUpdateBugsAction(["b1"], { severity: "high" })).toMatchObject({ ok: true, updated: 1 });
    expect(mocks.tx.issueWatch.createMany).not.toHaveBeenCalled();
    expect(mocks.notifyLater).not.toHaveBeenCalled();
  });

  it("does not queue notifications when a watch write fails inside the transaction", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.tx.issueWatch.createMany.mockRejectedValueOnce(new Error("Watch write failed"));
    expect(await bulkUpdateBugsAction(["b1"], { assigneeId: "new-assignee" })).toMatchObject({ error: expect.stringMatching(/Nothing was modified/) });
    expect(mocks.notifyLater).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("does not watch or notify when the batch loses a concurrent update race", async () => {
    mocks.tx.bug.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await bulkUpdateBugsAction(["b1"], { assigneeId: "new-assignee" })).toMatchObject({ error: expect.stringMatching(/Nothing was modified/) });
    expect(mocks.tx.issueWatch.createMany).not.toHaveBeenCalled();
    expect(mocks.notifyLater).not.toHaveBeenCalled();
  });

  it("requires authentication before side effects", async () => {
    mocks.requireUser.mockRejectedValueOnce(new Error("Not authenticated"));
    await expect(bulkUpdateBugsAction(["b1"], { assigneeId: "new-assignee" })).rejects.toThrow("Not authenticated");
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
    expect(mocks.notifyLater).not.toHaveBeenCalled();
  });

  it("requires tenant admin access", async () => {
    mocks.access.mockResolvedValueOnce({ admin: false });
    await expect(bulkUpdateBugsAction(["b1"], { assigneeId: "new-assignee" })).rejects.toThrow("redirect:/issues");
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });

  it("rejects invalid input before side effects", async () => {
    expect((await bulkUpdateBugsAction([], { assigneeId: "new-assignee" })).error).toBeTruthy();
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
    expect(mocks.notifyLater).not.toHaveBeenCalled();
  });
});

describe("bulk assignee workspace membership (Ziki #530)", () => {
  it("looks the assignee up only among members of the issues' workspace", async () => {
    expect(await bulkUpdateBugsAction(["b1"], { assigneeId: "new-assignee" })).toMatchObject({ ok: true, updated: 1 });
    expect(mocks.db.user.findFirst).toHaveBeenCalledTimes(2);
    for (const [query] of mocks.db.user.findFirst.mock.calls) {
      expect(query.where).toEqual({ id: "new-assignee", memberships: { some: { tenantId: "tenant-1" } } });
    }
  });

  it("refuses a user from another workspace and changes nothing", async () => {
    mocks.db.user.findFirst.mockResolvedValue(null);
    expect(await bulkUpdateBugsAction(["b1", "b2"], { assigneeId: "outsider" })).toEqual({
      error: "Assignee not found in this workspace",
    });
    expect(mocks.db.bug.findMany).not.toHaveBeenCalled();
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
    expect(mocks.tx.issueWatch.createMany).not.toHaveBeenCalled();
    expect(mocks.notifyLater).not.toHaveBeenCalled();
    expect(mocks.awardSolver).not.toHaveBeenCalled();
  });

  it("still lets an admin unassign without an assignee lookup", async () => {
    expect(await bulkUpdateBugsAction(["b1"], { assigneeId: "" })).toMatchObject({ ok: true, updated: 1 });
    expect(mocks.db.user.findFirst).not.toHaveBeenCalled();
  });
});
