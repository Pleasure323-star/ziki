import { beforeEach, describe, expect, it, vi } from "vitest";

/** Project settings (#595, #vote-governance): only workspace admins change a project's workflow, values are range-checked, and a saved change takes effect at once. */
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

import { updateProjectWorkflowAction } from "@/app/(app)/projects/[slug]/settings/workflow-actions";
import {
  DEFAULT_PROJECT_WORKFLOW,
  workflowSettingsSchema,
  workflowValues } from "@/lib/workflow-config";

function form(values: Record<string, string | number | boolean> = {}) {
  const data = new FormData();
  data.set("slug", "web");
  const merged = {
    ideaThreshold: 3,
    // One more than the default (3), so a plain save is a change.
    confirmationsNeeded: 4,
    verdictsNeeded: 3,
    offerWindowSeconds: 1800,
    heartbeatMinutes: 240,
    deliveryMinutes: 240,
    maxActiveClaims: 10,
    volunteerWindowSeconds: 120,
    autoMerge: true,
    abandonCheckMinutes: 120,
    abandonThreshold: 3,
    closeThreshold: 3,
    governance: "manager",
    managerVoteWeight: 3,
    awardThreshold: 3,
    acceptThreshold: 3,
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
      update: expect.objectContaining({ confirmationsNeeded: 4 }),
      create: expect.objectContaining({ projectId: "project-1", confirmationsNeeded: 4 }),
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        projectId: "project-1",
        actorUserId: "admin",
        action: "workflow.updated",
        changes: { confirmationsNeeded: { from: 3, to: 4 } },
      }),
    });
    expect(invalidateWorkflow).toHaveBeenCalledWith("project-1");
    expect(revalidatePath).toHaveBeenCalledWith("/projects/web/settings");
  });

  it("saves the vote governance settings, and refuses an unknown mode (#vote-governance)", async () => {
    await expect(
      updateProjectWorkflowAction(undefined, form({ governance: "threshold", managerVoteWeight: 4, awardThreshold: 5, acceptThreshold: 6 })),
    ).resolves.toEqual({ ok: true });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ governance: "threshold", managerVoteWeight: 4, awardThreshold: 5, acceptThreshold: 6 }),
      }),
    );
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        changes: expect.objectContaining({
          governance: { from: "manager", to: "threshold" },
          managerVoteWeight: { from: 3, to: 4 },
          awardThreshold: { from: 3, to: 5 },
          acceptThreshold: { from: 3, to: 6 },
        }),
      }),
    });
    transaction.mockClear();
    await expect(updateProjectWorkflowAction(undefined, form({ governance: "anarchy" }))).resolves.toMatchObject({
      ok: false,
      fieldErrors: { governance: expect.any(String) },
    });
    expect(transaction).not.toHaveBeenCalled();
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
      error: expect.any(String),
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("project workflow defaults (#595)", () => {

  it("uses defaults for a missing row", () => {
    expect(workflowValues(null)).toEqual(DEFAULT_PROJECT_WORKFLOW);
    expect(workflowValues({ confirmationsNeeded: 4 })).toMatchObject({
      confirmationsNeeded: 4,
      verdictsNeeded: 3,
      autoMerge: true,
    });
  });
});

describe("workflowSettingsSchema (#595)", () => {
  const valid = { ...DEFAULT_PROJECT_WORKFLOW };

  it("refuses values outside the documented ranges", () => {
    for (const [field, value] of [
      ["confirmationsNeeded", 0],
      ["confirmationsNeeded", 6],
      ["verdictsNeeded", 0],
      ["verdictsNeeded", 6],
      ["offerWindowSeconds", 29],
      ["offerWindowSeconds", 3601],
      ["abandonCheckMinutes", -1],
      ["abandonCheckMinutes", 10081],
      ["abandonThreshold", 0],
      ["abandonThreshold", 101],
      ["closeThreshold", 0],
      ["closeThreshold", 101],
    ] as const) {
      expect(workflowSettingsSchema.safeParse({ ...valid, [field]: value }).success).toBe(false);
    }
  });

});
