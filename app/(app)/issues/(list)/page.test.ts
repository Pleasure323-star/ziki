import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const count = vi.hoisted(() => vi.fn());
const findMany = vi.hoisted(() => vi.fn());
const projectFindFirst = vi.hoisted(() => vi.fn(async () => null));
const currentTenantIdFor = vi.hoisted(() => vi.fn());

vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "dave" } })) }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: vi.fn(async () => ({ id: "dave", role: "user" })) }));
vi.mock("@/lib/tenant-access", () => ({ currentTenantAccess: vi.fn(async () => ({ membershipRole: "owner" })) }));
vi.mock("@/lib/project-context", () => ({ activeProjectIdFor: vi.fn(async () => "project-acme") }));
vi.mock("@/lib/lookups", () => ({ getIssueTypes: vi.fn(async () => []), getPlatforms: vi.fn(async () => []) }));
vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findFirst: projectFindFirst },
    bug: { count, findMany, groupBy: vi.fn(async () => []) },
    milestone: { findMany: vi.fn(async () => []) },
  },
}));

import BugsPage from "./page";

/** What Postgres says mid-migration, before the tenant column exists. */
function missingTenantColumn() {
  return Object.assign(new Error('The column `Bug.tenantId` does not exist in the current database.'), {
    code: "P2022",
    meta: { column: "Bug.tenantId" },
  });
}

describe("issue list fails closed (#506)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentTenantIdFor.mockResolvedValue("tenant-acme");
  });

  it("shows an error instead of retrying without the tenant filter", async () => {
    count.mockRejectedValue(missingTenantColumn());

    const page = (await BugsPage({ searchParams: Promise.resolve({}) })) as ReactElement;
    const html = renderToStaticMarkup(page);

    expect(html).toMatch(/could not be loaded/i);
    // Every query that ran kept the tenant filter, and no list was fetched.
    for (const [args] of count.mock.calls) {
      expect(args.where).toMatchObject({ tenantId: "tenant-acme" });
    }
    expect(findMany).not.toHaveBeenCalled();
  });

  it("shows a reference, not the database error, when the count fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dbError = new Error('duplicate key value violates unique constraint "Bug_secret_idx"');
    count.mockRejectedValue(dbError);

    const html = renderToStaticMarkup((await BugsPage({ searchParams: Promise.resolve({}) })) as ReactElement);

    expect(html).toMatch(/could not be loaded/i);
    expect(html).not.toContain("Bug_secret_idx");
    expect(html).not.toContain("database error");
    const reference = html.match(/<code[^>]*>([0-9a-f]{8})<\/code>/)?.[1];
    expect(reference).toBeDefined();
    expect(consoleError).toHaveBeenCalledWith(`[bugs] list count failed (ref ${reference})`, dbError);
    consoleError.mockRestore();
  });

  it("shows a reference, not the database error, when the list query fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dbError = new Error('column "secret_col" of relation "Bug" does not exist');
    count.mockResolvedValue(3);
    findMany.mockRejectedValue(dbError);

    const html = renderToStaticMarkup((await BugsPage({ searchParams: Promise.resolve({}) })) as ReactElement);

    expect(html).toMatch(/could not be loaded/i);
    expect(html).not.toContain("secret_col");
    const reference = html.match(/<code[^>]*>([0-9a-f]{8})<\/code>/)?.[1];
    expect(reference).toBeDefined();
    expect(consoleError).toHaveBeenCalledWith(`[bugs] list query failed (ref ${reference})`, dbError);
    consoleError.mockRestore();
  });

  it("still gives someone with no membership an empty board, never other tenants' issues", async () => {
    currentTenantIdFor.mockResolvedValue(null);
    count.mockRejectedValueOnce(missingTenantColumn()).mockResolvedValue(0);
    findMany.mockResolvedValue([]);

    await BugsPage({ searchParams: Promise.resolve({}) });
    // Every later query either keeps the empty tenant scope or matches no ids.
    for (const [args] of [...count.mock.calls, ...findMany.mock.calls].slice(1)) {
      const where = args.where ?? {};
      const scoped = "tenantId" in where || (where.id && "in" in where.id && where.id.in.length === 0);
      expect(scoped).toBe(true);
    }
  });
});
