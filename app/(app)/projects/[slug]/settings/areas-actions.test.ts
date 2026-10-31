import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  currentTenantIdFor: vi.fn(),
  isTenantAdmin: vi.fn(),
  revalidatePath: vi.fn(),
  projectFindFirst: vi.fn(),
  areaFindMany: vi.fn(),
  areaFindFirst: vi.fn(),
  areaCreate: vi.fn(),
  areaUpdate: vi.fn(),
  areaDelete: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/agents/membership", () => ({ isTenantAdmin: mocks.isTenantAdmin }));
vi.mock("@/lib/tenant-context", () => ({ currentTenantIdFor: mocks.currentTenantIdFor, NO_TENANT_MESSAGE: "Join a workspace." }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findFirst: mocks.projectFindFirst },
    projectArea: { findMany: mocks.areaFindMany, findFirst: mocks.areaFindFirst },
    $transaction: mocks.transaction,
  },
}));

import { createProjectAreaAction, deleteProjectAreaAction, updateProjectAreaAction } from "./areas-actions";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const createForm = () => form({ slug: "web", name: "Frontend", description: "UI", paths: "apps/web/**" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "user-1", role: "user" });
  mocks.currentTenantIdFor.mockResolvedValue("tenant-1");
  mocks.isTenantAdmin.mockResolvedValue(true);
  mocks.projectFindFirst.mockResolvedValue({ id: "project-1", slug: "web" });
  mocks.areaFindMany.mockResolvedValue([]);
  mocks.areaFindFirst.mockResolvedValue({ id: "area-1", name: "Frontend", slug: "frontend", description: "UI", paths: ["apps/web/**"] });
  mocks.areaCreate.mockResolvedValue({ id: "area-new" });
  mocks.transaction.mockImplementation((work: (tx: unknown) => Promise<unknown>) => work({
    projectArea: { create: mocks.areaCreate, update: mocks.areaUpdate, delete: mocks.areaDelete },
    projectAuditEvent: { create: mocks.auditCreate },
  }));
});

describe("project area actions (#609)", () => {
  it("creates a project-scoped area and audits it", async () => {
    await expect(createProjectAreaAction(undefined, createForm())).resolves.toEqual({ ok: true });
    expect(mocks.areaCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: { projectId: "project-1", name: "Frontend", description: "UI", paths: ["apps/web/**"], slug: "frontend" },
    }));
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: "tenant-1", projectId: "project-1", action: "area.created" }),
    }));
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/web/settings");
  });

  describe("when two areas are created at the same moment (#968)", () => {
    const collision = (target: unknown = ["projectId", "slug"]) =>
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target },
      });

    it("re-reads the slugs and takes the next free one", async () => {
      mocks.areaFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ slug: "frontend" }]);
      mocks.areaCreate.mockRejectedValueOnce(collision()).mockResolvedValueOnce({ id: "area-new" });

      await expect(createProjectAreaAction(undefined, createForm())).resolves.toEqual({ ok: true });

      expect(mocks.areaCreate).toHaveBeenCalledTimes(2);
      expect(mocks.areaCreate.mock.calls[0][0].data.slug).toBe("frontend");
      expect(mocks.areaCreate.mock.calls[1][0].data.slug).not.toBe("frontend");
      expect(mocks.areaFindMany).toHaveBeenCalledTimes(2);
      expect(mocks.revalidatePath).toHaveBeenCalledWith("/projects/web/settings");
    });

    it("gives up with a message, not a thrown error, if it keeps losing the race", async () => {
      mocks.areaCreate.mockRejectedValue(collision());

      const result = await createProjectAreaAction(undefined, createForm());

      expect(result).toEqual({ ok: false, error: expect.stringMatching(/same time/i) });
      expect(mocks.areaCreate).toHaveBeenCalledTimes(3);
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    });

    it("still surfaces errors that are not a slug collision", async () => {
      mocks.areaCreate.mockRejectedValueOnce(new Error("connection lost"));
      await expect(createProjectAreaAction(undefined, createForm())).rejects.toThrow("connection lost");
      expect(mocks.areaCreate).toHaveBeenCalledTimes(1);

      mocks.areaCreate.mockReset();
      mocks.areaCreate.mockRejectedValueOnce(collision(["projectId", "name"]));
      await expect(createProjectAreaAction(undefined, createForm())).rejects.toThrow(/Unique constraint/);
      expect(mocks.areaCreate).toHaveBeenCalledTimes(1);
    });
  });

  it("requires an owner/admin before reading the project", async () => {
    mocks.isTenantAdmin.mockResolvedValue(false);
    await expect(createProjectAreaAction(undefined, createForm())).resolves.toMatchObject({ ok: false });
    expect(mocks.projectFindFirst).not.toHaveBeenCalled();
    expect(mocks.areaCreate).not.toHaveBeenCalled();
  });

  it("refuses to edit an area from another project", async () => {
    mocks.areaFindFirst.mockResolvedValue(null);
    await expect(updateProjectAreaAction(undefined, form({ ...Object.fromEntries(createForm().entries()), areaId: "foreign-area" }))).resolves.toEqual({ ok: false, error: expect.any(String) });
    expect(mocks.areaUpdate).not.toHaveBeenCalled();
  });

  it("deletes only a project-owned area and records the deletion", async () => {
    await expect(deleteProjectAreaAction(undefined, form({ slug: "web", areaId: "area-1" }))).resolves.toEqual({ ok: true });
    expect(mocks.areaDelete).toHaveBeenCalledWith({ where: { id: "area-1" } });
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "area.deleted" }),
    }));
  });
});