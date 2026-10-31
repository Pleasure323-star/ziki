import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

async function load() {
  vi.resetModules();
  return import("./tenant");
}

function dbReturning(...results: unknown[]) {
  const findFirst = vi.fn();
  for (const result of results) findFirst.mockResolvedValueOnce(result);
  return { db: { project: { findFirst } } as unknown as PrismaClient, findFirst };
}

describe("defaultTenantProject (#423)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns the Zedu tenant and project, looked up once", async () => {
    const { defaultTenantProject } = await load();
    const { db, findFirst } = dbReturning({ id: "project_zedu", tenantId: "tenant_zedu" });
    await expect(defaultTenantProject(db)).resolves.toEqual({
      tenantId: "tenant_zedu",
      projectId: "project_zedu",
    });
    await defaultTenantProject(db);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: "zedu", tenant: { slug: "zedu" } } }),
    );
  });

  it("fails clearly when the migration hasn't run, and tries again next time", async () => {
    const { defaultTenantProject } = await load();
    const { db, findFirst } = dbReturning(null, { id: "p", tenantId: "t" });
    await expect(defaultTenantProject(db)).rejects.toThrow();
    await expect(defaultTenantProject(db)).resolves.toEqual({ tenantId: "t", projectId: "p" });
    expect(findFirst).toHaveBeenCalledTimes(2);
  });
});
