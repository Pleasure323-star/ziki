import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.hoisted(() => vi.fn());
const isTenantAdmin = vi.hoisted(() => vi.fn());
const currentTenantIdFor = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const invalidateWorkflow = vi.hoisted(() => vi.fn());
const findFirst = vi.hoisted(() => vi.fn());
const upsert = vi.hoisted(() => vi.fn());
const auditCreate = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser }));
vi.mock("@/lib/agents/membership", () => ({ isTenantAdmin }));
vi.mock("@/lib/tenant-context", () => ({
  currentTenantIdFor,
  NO_TENANT_MESSAGE: "You're not a member of a workspace yet.",
}));
vi.mock("@/lib/workflow", () => ({ invalidateWorkflow }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findFirst },
    projectWorkflow: { upsert },
    projectAuditEvent: { create: auditCreate },
    $transaction: transaction,
  },
}));

import { updateProjectWorkflowAction } from "./workflow-actions";
import { DEFAULT_PROJECT_WORKFLOW } from "@/lib/workflow-config";

function form(values: Record<string, string | number | boolean> = {}) {
  const data = new FormData();
  data.set("slug", "web");
  const merged = {
    ideaThreshold: 3,
    confirmationsNeeded: 3,
    verdictsNeeded: 2,
    offerWindowSeconds: 1800,
    heartbeatMinutes: 240,
    deliveryMinutes: 240,
    maxActiveClaims: 2,
    volunteerWindowSeconds: 120,
    autoMerge: true,
    abandonCheckMinutes: 360,
    abandonThreshold: 3,
    closeThreshold: 3,
    ...values,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === "boolean") {
      if (value) data.set(key, "on");
    } else {
      data.set(key, String(value));
    }
  }
  return data;
}

describe("updateProjectWorkflowAction (#595)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "admin" });
    isTenantAdmin.mockResolvedValue(true);
    currentTenantIdFor.mockResolvedValue("tenant-1");
    findFirst.mockResolvedValue({ id: "project-1", slug: "web", workflow: null });
    transaction.mockImplementation(async (run: (tx: unknown) => unknown) =>
      run({
        projectWorkflow: { upsert },
        projectAuditEvent: { create: auditCreate },
      }),
    );
  });

  it("refuses a member who is not an admin", async () => {
    isTenantAdmin.mockResolvedValue(false);
    await expect(updateProjectWorkflowAction(undefined, form())).resolves.toMatchObject({ ok: false });
    expect(findFirst).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range value without writing", async () => {
    await expect(updateProjectWorkflowAction(undefined, form({ confirmationsNeeded: 6 }))).resolves.toMatchObject({
      ok: false,
      fieldErrors: { confirmationsNeeded: expect.stringContaining("at most 5") },
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("saves a change, audits it and invalidates the cache", async () => {
    await expect(updateProjectWorkflowAction(undefined, form())).resolves.toEqual({ ok: true });
    expect(upsert).toHaveBeenCalledWith({
      where: { projectId: "project-1" },
      update: expect.objectContaining({ confirmationsNeeded: 3 }),
      create: expect.objectContaining({ projectId: "project-1", confirmationsNeeded: 3 }),
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        projectId: "project-1",
        actorUserId: "admin",
        action: "workflow.updated",
        changes: { confirmationsNeeded: { from: 2, to: 3 } },
      }),
    });
    expect(invalidateWorkflow).toHaveBeenCalledWith("project-1");
    expect(revalidatePath).toHaveBeenCalledWith("/projects/web/settings");
  });

  it("saves the idea threshold (#idea-verdicts)", async () => {
    await expect(updateProjectWorkflowAction(undefined, form({ ideaThreshold: 5 }))).resolves.toEqual({ ok: true });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ ideaThreshold: 5 }) }),
    );
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        changes: expect.objectContaining({ ideaThreshold: { from: 3, to: 5 } }),
      }),
    });
  });

  it("rejects an idea threshold out of range", async () => {
    await expect(updateProjectWorkflowAction(undefined, form({ ideaThreshold: 0 }))).resolves.toMatchObject({
      ok: false,
      fieldErrors: { ideaThreshold: expect.any(String) },
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("saves the sense check settings (#abandon)", async () => {
    await expect(updateProjectWorkflowAction(undefined, form({ abandonCheckMinutes: 120, abandonThreshold: 5 }))).resolves.toEqual({ ok: true });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ abandonCheckMinutes: 120, abandonThreshold: 5 }) }),
    );
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        changes: expect.objectContaining({ abandonCheckMinutes: { from: 360, to: 120 }, abandonThreshold: { from: 3, to: 5 } }),
      }),
    });
  });

  it("saves the close threshold, and refuses one out of range (#close-superseded)", async () => {
    await expect(updateProjectWorkflowAction(undefined, form({ closeThreshold: 6 }))).resolves.toEqual({ ok: true });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ closeThreshold: 6 }) }),
    );
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        changes: expect.objectContaining({ closeThreshold: { from: 3, to: 6 } }),
      }),
    });
    transaction.mockClear();
    await expect(updateProjectWorkflowAction(undefined, form({ closeThreshold: 0 }))).resolves.toMatchObject({
      ok: false,
      fieldErrors: { closeThreshold: expect.any(String) },
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not audit or invalidate an unchanged save", async () => {
    findFirst.mockResolvedValue({ id: "project-1", slug: "web", workflow: DEFAULT_PROJECT_WORKFLOW });
    await expect(
      updateProjectWorkflowAction(undefined, form({ confirmationsNeeded: 2 })),
    ).resolves.toEqual({ ok: true });
    expect(transaction).not.toHaveBeenCalled();
    expect(invalidateWorkflow).not.toHaveBeenCalled();
  });

  it("does not report success when persistence fails", async () => {
    transaction.mockRejectedValueOnce(new Error("database down"));
    await expect(updateProjectWorkflowAction(undefined, form())).resolves.toMatchObject({ ok: false });
    expect(invalidateWorkflow).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does not touch a project outside the tenant", async () => {
    findFirst.mockResolvedValue(null);
    await expect(updateProjectWorkflowAction(undefined, form())).resolves.toMatchObject({
      ok: false,
      error: "Project not found.",
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});
