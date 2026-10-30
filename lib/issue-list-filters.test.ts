import { describe, expect, it } from "vitest";
import { parseBugListFilters, showsAllProjects } from "./issue-list-filters";

const tagTypes = [
  { id: "t1", name: "Design" },
  { id: "t2", name: "Fix" },
];

const parse = (params: Record<string, string | string[] | undefined>, over = {}) =>
  parseBugListFilters({
    params,
    userId: "u1",
    canSeeDeleted: false,
    tagTypes,
    ...over,
  });

describe("parseBugListFilters", () => {
  it("shows live issues by default", () => {
    expect(parse({}).where).toEqual({ isDeleted: false, duplicateOfId: null });
    expect(parse({}).isDeletedView).toBe(false);
  });

  it("hides duplicates unless asked for, like the list (#285)", () => {
    expect(parse({}).where.duplicateOfId).toBeNull();
    expect(parse({ duplicates: "show" }).where).not.toHaveProperty("duplicateOfId");
  });

  it("keeps deleted issues away from anyone who may not see them", () => {
    // The export is just another way of reading the same rows, so the same
    // rule has to hold there.
    const asUser = parse({ deleted: "true" });
    expect(asUser.where.isDeleted).toBe(false);
    expect(asUser.isDeletedView).toBe(false);

    const asAdmin = parse({ deleted: "true" }, { canSeeDeleted: true });
    expect(asAdmin.where.isDeleted).toBe(true);
    expect(asAdmin.isDeletedView).toBe(true);
  });

  it("applies status and severity only when they are real values", () => {
    expect(parse({ status: "open" }).where.status).toBe("open");
    expect(parse({ severity: "critical" }).where.severity).toBe("critical");
    expect(parse({ status: "sideways" }).where.status).toBeUndefined();
    expect(parse({ severity: "spicy" }).where.severity).toBeUndefined();
  });

  it("filters every pipeline step by the one status", () => {
    expect(parse({ status: "done" }).where.status).toBe("done");
    expect(parse({ status: "ready_to_merge" }).where.status).toBe("ready_to_merge");
    expect(parse({ reviewStatus: "submitted" }).where).not.toHaveProperty("reviewStatus");
  });

  it("understands the finished aggregate the stat grid links to (#685)", () => {
    // The Closed tile counts resolved + closed and links to ?status=finished;
    // the export has to return that same set, not every status.
    expect(parse({ status: "finished" }).where.status).toEqual({
      in: ["resolved", "closed"],
    });
    // Same parsing as the list, so an unknown token still means no filter.
    expect(parse({ status: "sideways" }).where.status).toBeUndefined();
  });

  it("scopes to the signed-in user for the mine filter", () => {
    expect(parse({ mine: "assigned" }).where.assigneeId).toBe("u1");
    expect(parse({ mine: "reported" }).where.reporterId).toBe("u1");
    expect(parse({ mine: "created" }).where.reporterId).toBe("u1");
  });

  it("treats the retired mine view as all issues and preserves other filters", () => {
    expect(parse({ mine: "mine" })).toEqual(parse({}));
    expect(parse({ mine: "mine", status: "open", q: "login" })).toEqual(
      parse({ status: "open", q: "login" }),
    );
  });

  it("ignores the mine filter when there is no user to scope to", () => {
    const anon = parse({ mine: "assigned" }, { userId: undefined });
    expect(anon.where.assigneeId).toBeUndefined();
  });

  it("filters by tag, matching every type with that name", () => {
    expect(parse({ tags: "design" }).where.typeId).toEqual({ in: ["t1"] });
  });

  it("searches title and description, and escapes the query", () => {
    const where = parse({ q: "100% sure" }).where;
    expect(where.OR).toHaveLength(2);
    // escapeSearchQuery neutralises LIKE wildcards so "%" is not a match-all.
    expect(where.OR).toEqual([
      { title: { contains: "100\\% sure", mode: "insensitive" } },
      { description: { contains: "100\\% sure", mode: "insensitive" } },
    ]);
  });

  it("escapes the LIKE wildcards so they match literally", () => {
    // Prisma binds `contains` as ILIKE '%' || $1 || '%' without escaping it,
    // so an unescaped "%" would match every issue and "_" would match any
    // single character. The search has to reach the database escaped.
    const where = parse({ q: "test_case" }).where;
    expect(where.OR).toEqual([
      { title: { contains: "test\\_case", mode: "insensitive" } },
      { description: { contains: "test\\_case", mode: "insensitive" } },
    ]);

    const percent = parse({ q: "%" }).where;
    expect(percent.OR).toEqual([
      { title: { contains: "\\%", mode: "insensitive" } },
      { description: { contains: "\\%", mode: "insensitive" } },
    ]);
  });

  it("adds no search condition for whitespace", () => {
    expect(parse({ q: "   " }).where.OR).toBeUndefined();
  });

  it("defaults the sort and accepts a real one", () => {
    expect(parse({}).sort).toBe("importance");
    expect(parse({ sort: "newest" }).sort).toBe("newest");
    expect(parse({ sort: "nonsense" }).sort).toBe("importance");
  });

  it("takes the first value when a param is repeated", () => {
    expect(parse({ status: ["open", "resolved"] }).where.status).toBe("open");
  });

  it("combines filters rather than letting the last one win", () => {
    const where = parse({ status: "open", severity: "high", mine: "reported" }).where;
    expect(where).toMatchObject({
      isDeleted: false,
      status: "open",
      severity: "high",
      reporterId: "u1",
    });
  });
});

describe("platform filter", () => {
  const platforms = [{ id: "cat_web" }, { id: "cat_mobile" }];
  const withPlatforms = (params: Record<string, string>) =>
    parseBugListFilters({ params, userId: "u1", canSeeDeleted: false, tagTypes, platforms });

  it("matches one platform", () => {
    expect(withPlatforms({ platform: "cat_web" }).where.categoryId).toBe("cat_web");
  });

  it("matches issues with no platform set", () => {
    expect(withPlatforms({ platform: "none" }).where.categoryId).toBeNull();
  });

  it("falls back to no filter for an id that no longer exists", () => {
    // Matching the list: a bookmark pointing at a deleted platform shows
    // issues, not a blank page the reader cannot explain.
    expect(withPlatforms({ platform: "gone" }).where.categoryId).toBeUndefined();
  });

  it("adds nothing when no platform is asked for", () => {
    expect(withPlatforms({}).where.categoryId).toBeUndefined();
  });
});

describe("project area filter (#609)", () => {
  const areas = [{ id: "area-web", name: "Frontend" }];
  const withAreas = (params: Record<string, string>) =>
    parseBugListFilters({ params, userId: "u1", canSeeDeleted: false, areas });

  it("filters an area belonging to the active project", () => {
    expect(withAreas({ area: "area-web" }).where.areaId).toBe("area-web");
  });

  it("supports no area and ignores a stale area id", () => {
    expect(withAreas({ area: "none" }).where.areaId).toBeNull();
    expect(withAreas({ area: "area-deleted" }).where.areaId).toBeUndefined();
  });
});

describe("workspace-wide ?project=all view", () => {
  it("is off unless the exact value is present", () => {
    expect(showsAllProjects(undefined)).toBe(false);
    expect(showsAllProjects("")).toBe(false);
    expect(showsAllProjects("ziki")).toBe(false);
    expect(showsAllProjects("all")).toBe(true);
    expect(showsAllProjects(["all"])).toBe(true);
  });

  it("never changes the shared list/export row filters", () => {
    // `project` is a view override handled by the list page, not a row filter,
    // so the export parser must keep producing the same where for it.
    expect(parse({ project: "all" }).where).toEqual(parse({}).where);
  });
});
