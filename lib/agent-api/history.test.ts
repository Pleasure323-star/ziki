import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; createdAt: Date } & Record<string, unknown>;

const tables = vi.hoisted(() => ({
  ideaVerdict: [] as Row[],
  issueConfirmation: [] as Row[],
  issueBid: [] as Row[],
  delivery: [] as Row[],
  testVerdict: [] as Row[],
  mergeReview: [] as Row[],
  comment: [] as Row[],
}));

type Clause = { createdAt: Date | { lt: Date }; id?: string | { lt: string } };

/** Applies the cursor part of a `where` (the only part these fixtures vary on). */
function afterCursor(row: Row, where: { OR?: Clause[]; AND?: Array<{ OR?: Clause[] }> }): boolean {
  const ors = [where.OR, ...(where.AND ?? []).map((part) => part.OR)].filter((or): or is Clause[] => Array.isArray(or) && "createdAt" in (or[0] ?? {}));
  return ors.every((or) => or.some((clause) => {
    const time = clause.createdAt instanceof Date
      ? row.createdAt.getTime() === clause.createdAt.getTime()
      : row.createdAt.getTime() < clause.createdAt.lt.getTime();
    if (!time) return false;
    if (clause.id === undefined) return true;
    return typeof clause.id === "string" ? row.id === clause.id : row.id < clause.id.lt;
  }));
}

const db = vi.hoisted(() => {
  const model = (name: keyof typeof tables) => ({
    findMany: vi.fn(async (args: { where: never; take: number }) =>
      tables[name]
        .filter((row) => afterCursor(row, args.where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .slice(0, args.take)),
  });
  return {
    ideaVerdict: model("ideaVerdict"),
    issueConfirmation: model("issueConfirmation"),
    issueBid: model("issueBid"),
    delivery: model("delivery"),
    testVerdict: model("testVerdict"),
    mergeReview: model("mergeReview"),
    comment: model("comment"),
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  HISTORY_KINDS,
  listOwnerHistory,
  parseHistoryQuery,
  type HistoryItem,
} from "./history";
import { IssueApiError } from "./errors";
import type { AgentContext } from "@/lib/agents/require-agent";

const me = { agentId: "agent_me", name: "me", ownerId: "owner", tenantId: "t1", level: "working", burst: false, keyId: "k", projectId: "p1" } as AgentContext;

const at = (minute: number) => new Date(Date.UTC(2026, 9, 31, 9, minute));
const MAIN: Record<string, string> = { requires_confirmation: "open", open: "open", in_progress: "in_progress" };
const issue = (substatus: string) => ({ id: "bug1", number: 7, title: "Export is greyed out", status: MAIN[substatus], substatus, projectId: "p1", project: { slug: "web" } });
const idea = (status: string) => ({ id: "idea1", number: 3, title: "CSV export", status, projectId: "p1" });
const entry = { summary: "Short.", description: "In full." };

function bid(id: string, minute: number, extra: Record<string, unknown> = {}): Row {
  return { id, createdAt: at(minute), updatedAt: at(minute), ...entry, withdrawnAt: null, awardedAt: null, agentId: "agent_me", agent: { id: "agent_me", name: "me" }, bug: issue("open"), ...extra };
}
function confirmation(id: string, minute: number, extra: Record<string, unknown> = {}): Row {
  return { id, createdAt: at(minute), updatedAt: at(minute), ...entry, verdict: "confirm", duplicateOfId: null, agentId: "agent_me", agent: { id: "agent_me", name: "me" }, bug: issue("requires_confirmation"), ...extra };
}
function ideaVerdict(id: string, minute: number, extra: Record<string, unknown> = {}): Row {
  return { id, createdAt: at(minute), updatedAt: at(minute), ...entry, opinion: "good", votes: 1, agent: null, idea: idea("open"), ...extra };
}
function comment(id: string, minute: number): Row {
  return { id, createdAt: at(minute), editedAt: null, body: "A reply.", parentId: null, agent: { id: "agent_me", name: "me" }, bug: issue("open") };
}

const query = (search: string) => parseHistoryQuery(new URLSearchParams(search));
const page = (search: string) => listOwnerHistory(me, { ...query(search), projectId: "p1" });
const find = (items: HistoryItem[], id: string) => items.find((item) => item.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  for (const rows of Object.values(tables)) rows.length = 0;
});

describe("history query", () => {
  it("reads every kind, 50 at a time, from the start by default", () => {
    expect(query("")).toEqual({ kinds: [...HISTORY_KINDS], limit: 50, cursor: null });
  });

  it("takes a comma-separated kind filter and refuses an unknown kind", () => {
    expect(query("kind=bid,%20comment").kinds.sort()).toEqual(["bid", "comment"]);
    expect(() => query("kind=bid,vote")).toThrow(IssueApiError);
    try { query("kind=vote"); } catch (error) { expect((error as IssueApiError).status).toBe(400); }
  });

  it("clamps a large limit and refuses one that is not a whole number in range", () => {
    expect(query("limit=500").limit).toBe(100);
    expect(query("limit=1").limit).toBe(1);
    for (const bad of ["0", "-1", "1.5", "abc"]) {
      try {
        query(`limit=${bad}`);
        expect.unreachable(`limit=${bad} should be refused`);
      } catch (error) {
        expect((error as IssueApiError).status).toBe(400);
      }
    }
  });

  it("round-trips its own cursor and refuses anything else", () => {
    const cursor = { createdAt: at(5), id: "bid1", kind: "bid" as const };
    expect(decodeHistoryCursor(encodeHistoryCursor(cursor))).toEqual(cursor);
    expect(decodeHistoryCursor("not-a-cursor")).toBeNull();
    expect(decodeHistoryCursor(Buffer.from(JSON.stringify([at(5).toISOString(), "x", "vote"])).toString("base64url"))).toBeNull();
    try {
      query("cursor=garbage");
      expect.unreachable("a foreign cursor should be refused");
    } catch (error) {
      expect((error as IssueApiError).status).toBe(400);
    }
  });
});

describe("listOwnerHistory", () => {
  it("merges every table newest first", async () => {
    tables.issueBid.push(bid("b1", 30));
    tables.issueConfirmation.push(confirmation("c1", 20));
    tables.ideaVerdict.push(ideaVerdict("v1", 10));
    tables.comment.push(comment("m1", 40));
    const { items, nextCursor } = await page("");
    expect(items.map((item) => [item.kind, item.id])).toEqual([["comment", "m1"], ["bid", "b1"], ["confirmation", "c1"], ["idea_verdict", "v1"]]);
    expect(nextCursor).toBeNull();
  });

  it("reads only the kinds asked for", async () => {
    tables.issueBid.push(bid("b1", 30));
    tables.comment.push(comment("m1", 40));
    const { items } = await page("kind=bid");
    expect(items.map((item) => item.id)).toEqual(["b1"]);
    expect(db.comment.findMany).not.toHaveBeenCalled();
  });

  it("pages through every item exactly once, ties included, by following nextCursor", async () => {
    tables.issueBid.push(bid("b1", 5), bid("b2", 3), bid("b3", 3));
    tables.issueConfirmation.push(confirmation("c1", 4), confirmation("c2", 3));
    tables.ideaVerdict.push(ideaVerdict("v1", 3), ideaVerdict("v2", 1));
    tables.comment.push(comment("m1", 6), comment("m2", 2));
    const all = await page("limit=100");
    expect(all.items).toHaveLength(9);

    for (const limit of [1, 2, 4]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const next: { items: HistoryItem[]; nextCursor: string | null } =
          await page(`limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
        expect(next.items.length).toBeLessThanOrEqual(limit);
        seen.push(...next.items.map((item) => item.id));
        cursor = next.nextCursor;
        pages += 1;
      } while (cursor && pages < 20);
      expect(seen).toEqual(all.items.map((item) => item.id));
    }
  });

  it("says how to replace an open bid it placed, and nothing for a bid it can't replace", async () => {
    tables.issueBid.push(
      bid("mine", 9),
      bid("teammate", 8, { agentId: "agent_other", agent: { id: "agent_other", name: "other" } }),
      bid("withdrawn", 7, { withdrawnAt: at(8) }),
      bid("awarded", 6, { awardedAt: at(8), bug: issue("in_progress") }),
    );
    const { items } = await page("");
    expect(find(items, "mine")).toMatchObject({ status: "open", edit: { method: "POST", path: "/api/v1/issues/bug1/bid?projectId=p1" } });
    expect(find(items, "mine").edit?.cli).toContain("--id bug1");
    expect(find(items, "teammate").edit).toBeNull();
    expect(find(items, "withdrawn")).toMatchObject({ status: "withdrawn", edit: null });
    expect(find(items, "awarded")).toMatchObject({ status: "awarded", edit: null });
  });

  it("lets any of the owner's agents replace a confirmation while the issue is being confirmed, and no later", async () => {
    tables.issueConfirmation.push(
      confirmation("current", 9, { agentId: "agent_other" }),
      confirmation("passed", 8, { bug: issue("open") }),
    );
    const { items } = await page("");
    expect(find(items, "current").edit).toMatchObject({ method: "POST", path: "/api/v1/issues/bug1/confirmations?projectId=p1" });
    expect(find(items, "passed").edit).toBeNull();
  });

  it("replaces an idea verdict only while the idea is open, and never edits a comment", async () => {
    tables.ideaVerdict.push(ideaVerdict("open", 9), ideaVerdict("converted", 8, { idea: idea("converted") }));
    tables.comment.push(comment("m1", 7));
    const { items } = await page("");
    expect(find(items, "open").edit).toMatchObject({ method: "POST", path: "/api/v1/ideas/idea1/verdicts?projectId=p1" });
    expect(find(items, "converted").edit).toBeNull();
    expect(find(items, "m1").edit).toBeNull();
  });

  it("links each item to its issue or idea", async () => {
    tables.issueBid.push(bid("b1", 2));
    tables.ideaVerdict.push(ideaVerdict("v1", 1));
    const { items } = await page("");
    expect(find(items, "b1")).toMatchObject({ issue: { id: "bug1", number: 7, status: "open", substatus: "open" } });
    expect((find(items, "b1") as { issue: { url: string } }).issue.url).toMatch(/\/web\/7$/);
    expect((find(items, "v1") as { idea: { url: string } }).idea.url).toMatch(/\/ideas\/3$/);
  });
});
