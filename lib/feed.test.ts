import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ bug: { findMany: vi.fn() }, project: { findFirst: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/tenant-context", () => ({ defaultProjectIdFor: vi.fn().mockResolvedValue("default-project") }));
import { FEED_MAX_PAGE_SIZE, FEED_PAGE_SIZE, FeedInputError, feedProject, feedWhere, parseFeedCursor, parseFeedLimit, readFeed } from "./feed";
import { AREA_NONE } from "@/lib/project-area-filter";

const timestamp = "2026-10-19T12:00:00.000Z";
describe("new-ticket feed", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires a complete, valid cursor", () => {
    expect(parseFeedCursor(new URLSearchParams())).toBeNull();
    for (const query of ["after=nope&afterId=a", `after=${timestamp}`, "afterId=a", "after=&afterId=a", "after=2026-02-30T00:00:00Z&afterId=a"]) {
      expect(() => parseFeedCursor(new URLSearchParams(query))).toThrow();
    }
    expect(parseFeedCursor(new URLSearchParams({ after: timestamp, afterId: "b" }))).toEqual({ after: timestamp, afterId: "b" });
  });

  it("names the actual cursor problem (#465)", () => {
    expect(() => parseFeedCursor(new URLSearchParams(`after=${timestamp}`))).toThrow("Supply both after (an ISO timestamp) and afterId.");
    expect(() => parseFeedCursor(new URLSearchParams("afterId=a"))).toThrow("Supply both after (an ISO timestamp) and afterId.");
    expect(() => parseFeedCursor(new URLSearchParams("after=garbage&afterId=x"))).toThrow("after must be an ISO-8601 timestamp");
    expect(() => parseFeedCursor(new URLSearchParams("after=2026-10-21&afterId=x"))).toThrow("after must be an ISO-8601 timestamp");
  });

  it("uses the id to continue inside a shared timestamp, with tenant/project isolation", async () => {
    const cursor = { after: timestamp, afterId: "b" };
    const where = feedWhere("tenant-a", "project-a", cursor);
    expect(where).toEqual({
      tenantId: "tenant-a", projectId: "project-a", isDeleted: false,
      OR: [{ createdAt: { gt: new Date(timestamp) } }, { createdAt: new Date(timestamp), id: { gt: "b" } }],
    });
    db.bug.findMany.mockResolvedValue([{ id: "c", createdAt: new Date(timestamp) }]);
    const result = await readFeed("tenant-a", "project-a", cursor);
    expect(db.bug.findMany).toHaveBeenCalledWith(expect.objectContaining({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }));
    expect(result.nextCursor).toEqual({ after: timestamp, afterId: "c" });
  });

  it("pages a backlog without advancing the cursor beyond returned issues", async () => {
    db.bug.findMany.mockResolvedValue(Array.from({ length: 51 }, (_, i) => ({ id: String(i), createdAt: new Date(timestamp) })));
    const page = await readFeed("t", "p", null);
    expect(page.issues).toHaveLength(50);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor?.afterId).toBe("49");
    db.bug.findMany.mockResolvedValue([]);
    expect((await readFeed("t", "p", page.nextCursor)).nextCursor).toEqual(page.nextCursor);
  });

  it("honours a limit argument when reading a page (#469)", async () => {
    db.bug.findMany.mockResolvedValue(Array.from({ length: 4 }, (_, i) => ({ id: String(i), createdAt: new Date(timestamp) })));
    const page = await readFeed("t", "p", null, null, 3);
    expect(db.bug.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 4 }));
    expect(page.issues).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor?.afterId).toBe("2");

    db.bug.findMany.mockResolvedValue(Array.from({ length: 2 }, (_, i) => ({ id: String(i), createdAt: new Date(timestamp) })));
    const last = await readFeed("t", "p", null, null, 3);
    expect(last.hasMore).toBe(false);
  });

  it("verifies an explicit project belongs to the tenant", async () => {
    db.project.findFirst.mockResolvedValue(null);
    expect(await feedProject("t", "foreign-project")).toBeNull();
    expect(db.project.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "foreign-project", tenantId: "t" } }));
    await feedProject("t");
    expect(db.project.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: "default-project", tenantId: "t" } }));
  });

  it("treats an empty or whitespace-only projectId as not given (#470)", async () => {
    db.project.findFirst.mockResolvedValue(null);
    for (const empty of ["", "   "]) {
      await feedProject("t", empty);
      expect(db.project.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: "default-project", tenantId: "t" } }));
    }
    await feedProject("t", "  real-project  ");
    expect(db.project.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: "real-project", tenantId: "t" } }));
  });
});

  it("filters a project feed by area, including issues with no area", () => {
    expect(feedWhere("tenant-a", "project-a", null, "area-1")).toMatchObject({ areaId: "area-1" });
    expect(feedWhere("tenant-a", "project-a", null, AREA_NONE)).toMatchObject({ areaId: null });
  });

describe("feed limit parameter (#469)", () => {
  it("keeps the historical page size when limit is absent", () => {
    expect(parseFeedLimit(new URLSearchParams())).toBe(FEED_PAGE_SIZE);
    expect(FEED_PAGE_SIZE).toBe(50);
  });

  it("returns the page size the caller asked for", () => {
    expect(parseFeedLimit(new URLSearchParams("limit=3"))).toBe(3);
    expect(parseFeedLimit(new URLSearchParams("limit=1"))).toBe(1);
    expect(parseFeedLimit(new URLSearchParams("limit=%203%20"))).toBe(3);
    expect(parseFeedLimit(new URLSearchParams(`limit=${FEED_MAX_PAGE_SIZE}`))).toBe(FEED_MAX_PAGE_SIZE);
  });

  it("clamps values above the maximum to the documented bound", () => {
    expect(parseFeedLimit(new URLSearchParams("limit=200"))).toBe(FEED_MAX_PAGE_SIZE);
  });

  it("rejects values that are not whole numbers of at least 1 instead of guessing", () => {
    for (const raw of ["", "0", "abc", "-1", "1.5", "1e3", "3px"]) {
      expect(() => parseFeedLimit(new URLSearchParams({ limit: raw })), raw).toThrow(FeedInputError);
    }
    let thrown: unknown;
    try {
      parseFeedLimit(new URLSearchParams("limit=0"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ status: 422, message: expect.stringContaining("limit") });
  });
});
