import { describe, expect, it } from "vitest";
import { FINISHED_STATUSES, finishedWatchedWhere, watchingWhere } from "./watching";
import {
  MINE_FILTER_OPTIONS,
  defaultSortFor,
  mineFilterLabels,
  mineFilterWhere,
  parseMineFilter,
} from "./mine-filter";
import { getBugOrderBy, parseBugSort } from "./issues-sort";
import { resolveWatchers } from "./watch";

/**
 * The where-clause is evaluated here against plain objects, so the test
 * checks who counts as watching rather than the shape of a Prisma object.
 */
type Row = { reporterId: string; assigneeId: string | null; watches: { userId: string; watching: boolean }[] };

/* eslint-disable @typescript-eslint/no-explicit-any */
function matches(row: Row, where: any): boolean {
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === "AND") return (cond as any[]).every((w) => matches(row, w));
    if (key === "OR") return (cond as any[]).some((w) => matches(row, w));
    if (key === "watches") {
      const rows = row.watches;
      const hit = (cond.some ?? cond.none) as { userId: string; watching: boolean };
      const found = rows.some((r) => r.userId === hit.userId && r.watching === hit.watching);
      return cond.some ? found : !found;
    }
    return (row as any)[key] === cond;
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const watching = (userId: string, row: Row) => matches(row, watchingWhere(userId));
const row = (r: Partial<Row>): Row => ({ reporterId: "other", assigneeId: null, watches: [], ...r });

describe("watchingWhere (#312)", () => {
  it("includes issues you reported or were assigned, with no watch row (implicit)", () => {
    expect(watching("me", row({ reporterId: "me" }))).toBe(true);
    expect(watching("me", row({ assigneeId: "me" }))).toBe(true);
  });

  it("includes issues you chose to watch", () => {
    expect(watching("me", row({ watches: [{ userId: "me", watching: true }] }))).toBe(true);
  });

  it("excludes issues you explicitly unwatched, even ones you reported", () => {
    const off = [{ userId: "me", watching: false }];
    expect(watching("me", row({ reporterId: "me", watches: off }))).toBe(false);
    expect(watching("me", row({ assigneeId: "me", watches: off }))).toBe(false);
  });

  it("excludes issues that have nothing to do with you", () => {
    expect(watching("me", row({}))).toBe(false);
  });

  it("ignores other people's watch rows", () => {
    expect(watching("me", row({ watches: [{ userId: "you", watching: true }] }))).toBe(false);
    expect(
      watching("me", row({ reporterId: "me", watches: [{ userId: "you", watching: false }] })),
    ).toBe(true);
  });

  it("agrees with who actually gets emailed", () => {
    // The list and the email audience must never disagree.
    const cases: Row[] = [
      row({ reporterId: "me" }),
      row({ assigneeId: "me" }),
      row({ reporterId: "me", watches: [{ userId: "me", watching: false }] }),
      row({ watches: [{ userId: "me", watching: true }] }),
      row({ watches: [{ userId: "me", watching: false }] }),
      row({}),
    ];
    for (const c of cases) {
      const audience = resolveWatchers([c.reporterId, c.assigneeId], c.watches);
      expect(watching("me", c), JSON.stringify(c)).toBe(audience.includes("me"));
    }
  });
});

describe("combining with the rest of the list", () => {
  it("doesn't use a top-level OR, which the search box overwrites", () => {
    expect(watchingWhere("me")).not.toHaveProperty("OR");
    const where = { isDeleted: false, ...mineFilterWhere("watching", "me") } as Record<string, unknown>;
    where.OR = [{ title: { contains: "x" } }]; // what the list's search does
    expect(where.AND).toEqual(watchingWhere("me").AND);
  });

  it("finished = watching, visible and resolved or closed", () => {
    const where = finishedWatchedWhere("me");
    expect(where.isDeleted).toBe(false);
    expect(where.status).toEqual({ in: [...FINISHED_STATUSES] });
    expect(where.AND).toEqual(watchingWhere("me").AND);
    expect([...FINISHED_STATUSES]).toEqual(["resolved", "closed"]);
  });
});

describe("the Show filter", () => {
  it("offers watching, labelled", () => {
    expect(MINE_FILTER_OPTIONS).toContain("watching");
    expect(mineFilterLabels.watching).toMatch(/watching/i);
    expect(parseMineFilter(" Watching ")).toBe("watching");
  });
  it("applies only with a signed-in user", () => {
    expect(mineFilterWhere("watching", undefined)).toEqual({});
    expect(mineFilterWhere("watching", "me")).toEqual(watchingWhere("me"));
  });
});

describe("order (most recent activity)", () => {
  it("defaults the watching view to recently updated, and leaves others alone", () => {
    expect(defaultSortFor("watching")).toBe("recently_updated");
    expect(defaultSortFor("assigned")).toBe("importance");
    expect(defaultSortFor(null)).toBe("importance");
  });
  it("still honours an explicit sort", () => {
    expect(parseBugSort("newest", defaultSortFor("watching"))).toBe("newest");
    expect(parseBugSort(undefined, defaultSortFor("watching"))).toBe("recently_updated");
    expect(parseBugSort("nonsense", defaultSortFor("watching"))).toBe("recently_updated");
    expect(parseBugSort(undefined)).toBe("importance");
  });
  it("can leave boosted issues out of the order", () => {
    const withBoost = getBugOrderBy("recently_updated");
    const without = getBugOrderBy("recently_updated", { boostFirst: false });
    expect(withBoost[0]).toEqual({ isBoosted: "desc" });
    expect(without).toEqual([{ updatedAt: "desc" }, { id: "desc" }]);
  });
});
