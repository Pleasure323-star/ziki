import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { decodePointCursor, pointEntries, pointEntriesQuerySchema } from "./entries";

const at = new Date("2026-10-22T12:00:00Z");
function row(id: string, points = 5) {
  return { id, points, sourceKey: "reporter:issue:owner", role: "reporter", createdAt: at, bug: { id: "issue", number: 7, title: "Example", tenantId: "tenant", projectId: "project", isDeleted: false, project: { slug: "ziki" } } };
}
function database(rows: unknown[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return { db: { pointEntry: { findMany } } as unknown as PrismaClient, findMany };
}
const scope = { tenantId: "tenant", userId: "owner", visibleProjectId: "project" };

describe("points ledger entries (#461)", () => {
  it("keeps corrections separate and scopes the query to the owner and tenant", async () => {
    const { db, findMany } = database([row("b"), row("a", -5)]);
    const result = await pointEntries(db, scope, { limit: 25 });
    expect(result.items.map(x => x.points)).toEqual([5, -5]);
    expect(result.items[1].source).toBe("Correction");
    expect(result.items[0].issue).toEqual({ id: "issue", number: 7, title: "Example", path: "/ziki/7" });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant", userId: "owner" }, take: 26,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }));
    expect(JSON.stringify(result)).not.toContain("sourceKey");
    expect(result.nextCursor).toBeNull();
  });
  it("uses the last displayed entry for paging, including equal timestamps", async () => {
    const { db, findMany } = database([row("c"), row("b"), row("a")]);
    const first = await pointEntries(db, scope, { limit: 2 });
    expect(first.items.map(x => x.id)).toEqual(["c", "b"]);
    expect(decodePointCursor(first.nextCursor!)).toEqual({ at: at.toISOString(), id: "b" });
    await pointEntries(db, scope, { limit: 2, cursor: first.nextCursor! });
    expect(findMany.mock.calls[1][0].where).toEqual({ tenantId: "tenant", userId: "owner", OR: [
      { createdAt: { lt: at } }, { createdAt: at, id: { lt: "b" } },
    ] });
  });
  it("keeps tenant and owner restrictions with a forged cursor", async () => {
    const { db, findMany } = database([]);
    const cursor = Buffer.from(JSON.stringify({ at: at.toISOString(), id: "foreign-entry" })).toString("base64url");
    await pointEntries(db, scope, { limit: 25, cursor });
    expect(findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "tenant", userId: "owner" });
  });
  it("includes the entire UTC end date and retains date bounds when paging", async () => {
    const { db, findMany } = database([]);
    await pointEntries(db, scope, { limit: 25, from: "2026-10-01", to: "2026-10-22" });
    expect(findMany.mock.calls[0][0].where.createdAt).toEqual({ gte: new Date("2026-10-01T00:00:00Z"), lte: new Date("2026-10-22T23:59:59.999Z") });
  });
  it("redacts missing, deleted, foreign-tenant and out-of-project issue details", async () => {
    const deleted = row("deleted"); deleted.bug.isDeleted = true;
    const tenant = row("tenant"); tenant.bug.tenantId = "other";
    const project = row("project"); project.bug.projectId = "other";
    const { db } = database([{ ...row("missing"), bug: null }, deleted, tenant, project]);
    const result = await pointEntries(db, scope, { limit: 25 });
    expect(result.items).toHaveLength(4);
    expect(result.items.every(x => x.issue === null)).toBe(true);
  });
  it("explains confirmation review awards without exposing their internal source key", async () => {
    const entry = { ...row("review"), role: "reviewer", sourceKey: "reviewer-confirm:private-issue:owner" };
    const { db } = database([entry]);
    const result = await pointEntries(db, scope, { limit: 25 });
    expect(result.items[0].source).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("reviewer-confirm:");
  });
  it("returns an empty final page", async () => {
    const { db } = database([]);
    await expect(pointEntries(db, scope, { limit: 25 })).resolves.toEqual({ items: [], nextCursor: null });
  });
  it.each([{ limit: 0 }, { limit: 101 }, { from: "1" }, { to: "bad" }, { from: "2026-10-23", to: "2026-10-22" }])("rejects invalid query %j", query => {
    expect(pointEntriesQuerySchema.safeParse(query).success).toBe(false);
  });
  it.each(["bad", Buffer.from('{}').toString('base64url')])("rejects malformed cursors before a query", async cursor => {
    const { db, findMany } = database([]);
    await expect(pointEntries(db, scope, { limit: 25, cursor })).rejects.toThrow();
    expect(findMany).not.toHaveBeenCalled();
  });
});
