import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  agentApiKey: { findUnique: vi.fn() }, agentAuditEvent: { create: vi.fn() },
  agentInboxItem: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  bug: { findMany: vi.fn() },
}));
const budget = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agents/rate-budget", async (original) => ({ ...await original<typeof import("@/lib/agents/rate-budget")>(), consumeAgentBudget: budget }));

import { GET } from "./route";
import { POST } from "./read/route";
import { decodeEventCursor } from "@/lib/agent-api/events";

function request(path = "/inbox", method = "GET", body?: unknown, key = true) {
  return new NextRequest(`http://localhost/api/v1${path}`, { method,
    headers: { ...(key ? { authorization: "Bearer ziki_test-key" } : {}), "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
function key(level = "working") {
  return { id: "key-a", revokedAt: null, agent: { id: "agent-bob", name: "Bob's agent", ownerUserId: "bob", tenantId: "tenant-a", level, burst: false, revokedAt: null, owner: { memberships: [{ tenantId: "tenant-a" }] } } };
}
const item = { id: "item-1", kind: "reply", eventId: "event-1", eventType: "comment.created", bugId: "bug-1", commentId: "c2",
  payload: { commentId: "c2" }, readAt: null, createdAt: new Date("2026-10-20T10:00:00Z") };

beforeEach(() => {
  vi.resetAllMocks();
  db.agentApiKey.findUnique.mockResolvedValue(key());
  budget.mockResolvedValue({ allowed: true });
  db.agentInboxItem.findMany.mockResolvedValue([]);
});

describe("GET /api/v1/inbox", () => {
  it("rejects anonymous calls", async () => {
    expect((await GET(request("/inbox", "GET", undefined, false))).status).toBe(401);
    expect(db.agentInboxItem.findMany).not.toHaveBeenCalled();
  });

  it("returns the caller's own items, charges a read and audits", async () => {
    db.agentInboxItem.findMany.mockResolvedValue([item]);
    db.bug.findMany.mockResolvedValue([{ id: "bug-1", number: 7, project: { slug: "ziki" } }]);
    const response = await GET(request("/inbox?unread=1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body.items).toEqual([expect.objectContaining({ id: "item-1", kind: "reply", issueId: "bug-1", commentId: "c2", read: false })]);
    expect(body.items[0].url).toMatch(/\/ziki\/7\?comment=c2#comment-c2$/);
    expect(decodeEventCursor(body.cursor)?.id).toBe("item-1");
    expect(body.hasMore).toBe(false);
    expect(db.agentInboxItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { agentId: "agent-bob", readAt: null } }));
    expect(budget).toHaveBeenCalledWith({ id: "agent-bob", burst: false, burstUntil: null }, "read");
    expect(db.agentAuditEvent.create).toHaveBeenCalled();
  });

  it("validates input and reports an unavailable inbox", async () => {
    for (const query of ["wait=26", "wait=bad", "after=bad", "unread=yes"]) {
      expect((await GET(request(`/inbox?${query}`))).status).toBe(400);
    }
    db.agentInboxItem.findMany.mockRejectedValueOnce(new Error("DB"));
    expect((await GET(request())).status).toBe(503);
  });
});

describe("POST /api/v1/inbox/read", () => {
  it("marks ids read for the caller and is charged as a read", async () => {
    db.agentInboxItem.updateMany.mockResolvedValue({ count: 1 });
    const response = await POST(request("/inbox/read", "POST", { ids: ["item-1"] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ marked: 1 });
    expect(db.agentInboxItem.updateMany.mock.calls[0][0].where).toEqual({ agentId: "agent-bob", id: { in: ["item-1"] }, readAt: null });
    expect(budget).toHaveBeenCalledWith({ id: "agent-bob", burst: false, burstUntil: null }, "read");
  });

  it("hides read items from ?unread=1", async () => {
    db.agentInboxItem.findFirst.mockResolvedValue({ id: "item-1", createdAt: item.createdAt });
    db.agentInboxItem.updateMany.mockResolvedValue({ count: 1 });
    expect((await POST(request("/inbox/read", "POST", { upTo: "item-1" }))).status).toBe(200);
    // The unread filter is part of the query, so a read item is not returned.
    await GET(request("/inbox?unread=1"));
    expect(db.agentInboxItem.findMany.mock.calls.at(-1)?.[0].where).toMatchObject({ readAt: null });
  });

  it("rejects bad bodies and unknown anchors", async () => {
    expect((await POST(request("/inbox/read", "POST", {}))).status).toBe(422);
    db.agentInboxItem.findFirst.mockResolvedValue(null);
    expect((await POST(request("/inbox/read", "POST", { upTo: "nope" }))).status).toBe(404);
    expect((await POST(request("/inbox/read", "POST", undefined, false))).status).toBe(401);
  });
});
