import { describe, expect, it } from "vitest";
import {
  COMMENT_THREADS_PER_PAGE,
  MAX_COMMENT_THREADS,
  commentPermalinkPath,
  earlierThreadsHref,
  loadCommentWindow,
  parseCommentTarget,
  parseThreadWindow,
} from "./comment-window";

type Row = {
  id: string;
  bugId: string;
  parentId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  body: string;
  confirmationId?: string | null;
  bidId?: string | null;
  testVerdictId?: string | null;
  mergeReviewId?: string | null;
};

/** Just enough of Prisma's `comment` delegate for the loader, over an array. */
function fakeDb(rows: Row[]) {
  const queries: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const match = (row: Row, where: any): boolean =>
    Object.entries(where ?? {}).every(([key, cond]) => {
      if (key === "OR") return (cond as unknown[]).some((w) => match(row, w));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const value = (row as any)[key];
      if (cond === null) return value == null;
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = cond as any;
        if ("in" in c) return c.in.includes(value);
        if ("gt" in c) return value > c.gt;
        if ("gte" in c) return value >= c.gte;
      }
      if (cond instanceof Date) return value?.getTime() === cond.getTime();
      return value === cond;
    });
  const sorted = (list: Row[], desc: boolean) =>
    [...list].sort((a, b) => {
      const d = a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
      return desc ? -d : d;
    });
  const db = {
    comment: {
      count: async ({ where }: { where: unknown }) => {
        queries.push("count");
        return rows.filter((r) => match(r, where)).length;
      },
      findFirst: async ({ where }: { where: unknown }) => {
        queries.push("findFirst");
        return rows.find((r) => match(r, where)) ?? null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where, orderBy, take, include }: any) => {
        queries.push(include ? "findMany:full" : "findMany:ids");
        const desc = Array.isArray(orderBy) && orderBy[0]?.createdAt === "desc";
        let list = sorted(rows.filter((r) => match(r, where)), desc);
        if (take) list = list.slice(0, take);
        return list.map((r) => ({ ...r, authorId: "u", author: { name: "U" }, parent: null }));
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, queries };
}

const t = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));

/** `threads` roots, each with one reply and one reply-to-reply. */
function issueWith(threads: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < threads; i++) {
    const root = `r${String(i).padStart(4, "0")}`;
    rows.push({ id: root, bugId: "b", parentId: null, createdAt: t(i * 10), deletedAt: null, body: "" });
    rows.push({ id: `${root}a`, bugId: "b", parentId: root, createdAt: t(i * 10 + 1), deletedAt: null, body: "" });
    rows.push({ id: `${root}b`, bugId: "b", parentId: `${root}a`, createdAt: t(i * 10 + 2), deletedAt: null, body: "" });
  }
  rows.push({ id: "other", bugId: "x", parentId: null, createdAt: t(5), deletedAt: null, body: "" });
  return rows;
}

describe("parseThreadWindow", () => {
  it("defaults, floors at one page, caps, and accepts 'all'", () => {
    expect(parseThreadWindow(undefined)).toBe(COMMENT_THREADS_PER_PAGE);
    expect(parseThreadWindow("abc")).toBe(COMMENT_THREADS_PER_PAGE);
    expect(parseThreadWindow("3")).toBe(COMMENT_THREADS_PER_PAGE);
    expect(parseThreadWindow("100")).toBe(100);
    expect(parseThreadWindow("1e9")).toBe(MAX_COMMENT_THREADS);
    expect(parseThreadWindow(["all", "5"])).toBe(MAX_COMMENT_THREADS);
  });
});

describe("parseCommentTarget", () => {
  it("accepts id-shaped values only", () => {
    expect(parseCommentTarget("ckx12_ab-3")).toBe("ckx12_ab-3");
    expect(parseCommentTarget("../etc")).toBeNull();
    expect(parseCommentTarget("")).toBeNull();
    expect(parseCommentTarget(undefined)).toBeNull();
  });
});

describe("links", () => {
  it("permalinks carry both the query and the fragment", () => {
    expect(commentPermalinkPath("b1", "c9")).toBe("/issues/b1?comment=c9#comment-c9");
  });
  it("'show earlier' keeps other params and drops a stale target", () => {
    const href = earlierThreadsHref(new URLSearchParams("comment=c1&x=1"), 50);
    expect(href).toBe("?x=1&threads=100#comments");
    expect(earlierThreadsHref(new URLSearchParams(), 50, true)).toBe("?threads=all#comments");
  });
});

describe("loadCommentWindow", () => {
  it("loads everything for a small issue", async () => {
    const { db } = fakeDb(issueWith(3));
    const w = await loadCommentWindow(db, "b", { threads: 50 });
    expect(w.comments).toHaveLength(9);
    expect(w).toMatchObject({ shownThreads: 3, hiddenThreads: 0, visibleCount: 9 });
    expect(w.comments.map((c) => c.id)[0]).toBe("r0000");
  });

  it("leaves replies to a confirmation entry out of the threads: they show under the entry (#issue-confirmations)", async () => {
    const rows = issueWith(2);
    rows.push({ id: "reply-to-entry", bugId: "b", parentId: null, createdAt: new Date("2030-01-01T00:00:00Z"), deletedAt: null, body: "Try Firefox.", confirmationId: "c1" });
    const { db } = fakeDb(rows);
    const w = await loadCommentWindow(db, "b", { threads: 50 });
    expect(w.shownThreads).toBe(2);
    expect(w.comments.map((c) => c.id)).not.toContain("reply-to-entry");
  });

  it("leaves replies to a bid out of the threads too: they show under the bid (#issue-bids)", async () => {
    const rows = issueWith(2);
    rows.push({ id: "reply-to-bid", bugId: "b", parentId: null, createdAt: new Date("2030-01-01T00:00:00Z"), deletedAt: null, body: "Add a test.", bidId: "bid1" });
    const { db } = fakeDb(rows);
    const w = await loadCommentWindow(db, "b", { threads: 50 });
    expect(w.shownThreads).toBe(2);
    expect(w.comments.map((c) => c.id)).not.toContain("reply-to-bid");
  });

  it("leaves replies to a test verdict or a merge review out of the threads too (#review-entries)", async () => {
    const rows = issueWith(2);
    rows.push({ id: "reply-to-verdict", bugId: "b", parentId: null, createdAt: new Date("2030-01-01T00:00:00Z"), deletedAt: null, body: "Which browser?", testVerdictId: "tv1" });
    rows.push({ id: "reply-to-review", bugId: "b", parentId: null, createdAt: new Date("2030-01-02T00:00:00Z"), deletedAt: null, body: "On it.", mergeReviewId: "mr1" });
    const { db } = fakeDb(rows);
    const w = await loadCommentWindow(db, "b", { threads: 50 });
    expect(w.shownThreads).toBe(2);
    expect(w.comments.map((c) => c.id)).not.toContain("reply-to-verdict");
    expect(w.comments.map((c) => c.id)).not.toContain("reply-to-review");
  });

  it("loads only the newest threads, whole, in chronological order", async () => {
    const { db } = fakeDb(issueWith(200));
    const w = await loadCommentWindow(db, "b", { threads: 50 });
    expect(w).toMatchObject({ shownThreads: 50, hiddenThreads: 150, visibleCount: 600 });
    expect(w.comments).toHaveLength(150);
    expect(w.comments[0].id).toBe("r0150");
    expect(w.comments.at(-1)!.id).toBe("r0199b");
    // every reply's parent is present: no thread is cut
    const ids = new Set(w.comments.map((c) => c.id));
    expect(w.comments.every((c) => !c.parentId || ids.has(c.parentId))).toBe(true);
  });

  it("does a fixed number of queries however many comments there are", async () => {
    const small = fakeDb(issueWith(5));
    await loadCommentWindow(small.db, "b", { threads: 50 });
    const big = fakeDb(issueWith(500));
    await loadCommentWindow(big.db, "b", { threads: 50 });
    expect(big.queries).toEqual(small.queries);
  });

  it("widens the window to reach a permalinked comment's thread", async () => {
    const { db } = fakeDb(issueWith(200));
    const w = await loadCommentWindow(db, "b", { threads: 50, target: "r0010b" });
    expect(w.comments.some((c) => c.id === "r0010b")).toBe(true);
    expect(w.shownThreads).toBe(190);
    expect(w.hiddenThreads).toBe(10);
  });

  it("ignores a target on another issue or that doesn't exist", async () => {
    const { db } = fakeDb(issueWith(200));
    expect((await loadCommentWindow(db, "b", { threads: 50, target: "other" })).shownThreads).toBe(50);
    expect((await loadCommentWindow(db, "b", { threads: 50, target: "nope" })).shownThreads).toBe(50);
  });

  it("doesn't count deleted comments as visible", async () => {
    const rows = issueWith(2);
    rows[0].deletedAt = t(99);
    const { db } = fakeDb(rows);
    expect((await loadCommentWindow(db, "b", { threads: 50 })).visibleCount).toBe(5);
  });
});
