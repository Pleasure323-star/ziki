import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  projectWorkflow: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { invalidateWorkflow, resetWorkflowCache, workflowFor } from "./workflow";
import { DEFAULT_PROJECT_WORKFLOW } from "./workflow-config";

const row = {
  confirmationsNeeded: 3,
  verdictsNeeded: 4,
  offerWindowSeconds: 120,
  heartbeatMinutes: 20,
  deliveryMinutes: 30,
  maxActiveClaims: 3,
  volunteerWindowSeconds: 300,
  autoMerge: false,
  ideaThreshold: 5,
  abandonCheckMinutes: 90,
  abandonThreshold: 4,
  closeThreshold: 6,
};

describe("workflowFor (#595)", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    resetWorkflowCache();
    db.projectWorkflow.findUnique.mockReset();
  });

  it("returns the stored settings for a project", async () => {
    db.projectWorkflow.findUnique.mockResolvedValue(row);
    await expect(workflowFor("project-a")).resolves.toEqual(row);
    expect(db.projectWorkflow.findUnique).toHaveBeenCalledWith({
      where: { projectId: "project-a" },
      select: expect.objectContaining({ confirmationsNeeded: true, autoMerge: true, abandonCheckMinutes: true, abandonThreshold: true, closeThreshold: true }),
    });
  });

  it("falls back to defaults when the project has no row", async () => {
    db.projectWorkflow.findUnique.mockResolvedValue(null);
    await expect(workflowFor("project-a")).resolves.toEqual(DEFAULT_PROJECT_WORKFLOW);
  });

  it("keeps one project's cache away from another", async () => {
    db.projectWorkflow.findUnique
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, confirmationsNeeded: 5 });
    expect((await workflowFor("project-a")).confirmationsNeeded).toBe(3);
    expect((await workflowFor("project-b")).confirmationsNeeded).toBe(5);
    expect((await workflowFor("project-a")).confirmationsNeeded).toBe(3);
    expect(db.projectWorkflow.findUnique).toHaveBeenCalledTimes(2);
  });

  it("expires the cache after 30 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    db.projectWorkflow.findUnique.mockResolvedValue(row);
    await workflowFor("project-a");
    await workflowFor("project-a");
    expect(db.projectWorkflow.findUnique).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-20T12:00:31Z"));
    await workflowFor("project-a");
    expect(db.projectWorkflow.findUnique).toHaveBeenCalledTimes(2);
  });

  it("invalidates immediately after a settings edit", async () => {
    db.projectWorkflow.findUnique.mockResolvedValue(row);
    await workflowFor("project-a");
    invalidateWorkflow("project-a");
    await workflowFor("project-a");
    expect(db.projectWorkflow.findUnique).toHaveBeenCalledTimes(2);
  });

  it("does not cache a missing row, so a new row takes effect at once", async () => {
    db.projectWorkflow.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row);
    await workflowFor("project-a");
    expect((await workflowFor("project-a")).confirmationsNeeded).toBe(3);
    expect(db.projectWorkflow.findUnique).toHaveBeenCalledTimes(2);
  });

  it("returns defaults for a test double without the delegate", async () => {
    await expect(workflowFor("project-a", {} as never)).resolves.toEqual(DEFAULT_PROJECT_WORKFLOW);
  });

  it("returns defaults when the workflow table has not been migrated", async () => {
    const missing = Object.assign(
      new Error("The table `public.ProjectWorkflow` does not exist in the current database."),
      { code: "P2021", meta: { table: "public.ProjectWorkflow" } },
    );
    db.projectWorkflow.findUnique.mockRejectedValue(missing);
    await expect(workflowFor("project-a")).resolves.toEqual(DEFAULT_PROJECT_WORKFLOW);
    await expect(workflowFor("project-a")).resolves.toEqual(DEFAULT_PROJECT_WORKFLOW);
    expect(db.projectWorkflow.findUnique).toHaveBeenCalledTimes(2);
  });
});
