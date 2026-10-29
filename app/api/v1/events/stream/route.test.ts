import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const db = vi.hoisted(() => ({
  agentApiKey: { findUnique: vi.fn() },
  agentAuditEvent: { create: vi.fn() },
  agentEvent: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
}));
const budget = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agents/rate-budget", async (original) => ({ ...(await original<typeof import("@/lib/agents/rate-budget")>()), consumeAgentBudget: budget }));
import { GET } from "./route";
import { eventStreamBus } from "@/lib/events/stream-bus";
import { encodeEventCursor } from "@/lib/agent-api/events";

function request(path = "/events/stream", method = "GET", body?: unknown, key = true) {
  return new NextRequest(`http://localhost/api/v1${path}`, {
    method,
    headers: { ...(key ? { authorization: "Bearer ziki_test-key" } : {}), "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const key = () => ({
  id: "key-a",
  revokedAt: null,
  projectId: null,
  project: null,
  agent: {
    id: "agent-a",
    name: "Agent",
    ownerUserId: "owner",
    tenantId: "tenant-a",
    level: "working",
    burst: false,
    revokedAt: null,
    owner: { memberships: [{ tenantId: "tenant-a" }] },
  },
});

/** A key scoped to one project, as pairing issues it. */
function scopedKey(projectId = "project-a") {
  return { ...key(), projectId, project: { slug: "alpha" } };
}

beforeEach(() => {
  vi.resetAllMocks();
  db.agentApiKey.findUnique.mockResolvedValue(key());
  budget.mockResolvedValue({ allowed: true });
  db.agentEvent.findMany.mockResolvedValue([]);
  db.$queryRaw.mockResolvedValue([{ xmin: "1000" }]);
  eventStreamBus.clear();
});

afterEach(() => {
  vi.useRealTimers();
  eventStreamBus.clear();
});

describe("events/stream SSE endpoint", () => {
  it("returns SSE headers and requires authentication", async () => {
    const res = await GET(request("/events/stream", "GET", undefined, false));
    expect(res.status).toBe(401);

    db.agentApiKey.findUnique.mockResolvedValueOnce(null);
    const res2 = await GET(request("/events/stream"));
    expect(res2.status).toBe(401);
  });

  it("streams with correct headers and sends connected event", async () => {
    const res = await GET(request("/events/stream"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    expect(res.headers.get("connection")).toBe("keep-alive");

    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();
    const { value } = await reader!.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: connected");
    reader!.cancel();
  });

  it("broadcasts events to subscribers with proper SSE formatting", async () => {
    const res = await GET(request("/events/stream"));
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    await reader!.read(); // consume connected event

    // Broadcast an event
    eventStreamBus.broadcast({
      id: "evt-1",
      type: "issue.created",
      payload: { issueId: "issue-1" },
      actorAgentId: "agent-a",
      bugId: "issue-1",
      tenantId: "tenant-a",
      createdAt: new Date("2026-10-19T12:00:00Z"),
    });

    const { value } = await reader!.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("id: evt-1");
    expect(text).toContain("event: issue.created");
    expect(text).toContain("data:");
    const dataMatch = text.match(/data: (.+)\n\n/);
    expect(dataMatch).toBeTruthy();
    const data = JSON.parse(dataMatch![1]);
    expect(data.type).toBe("issue.created");
    expect(data.bugId).toBe("issue-1");

    reader!.cancel();
  });

  it("filters events by type", async () => {
    const res = await GET(request("/events/stream?types=comment.created"));
    const reader = res.body?.getReader();
    await reader!.read(); // connected

    // Should not receive issue.created
    eventStreamBus.broadcast({
      id: "evt-1",
      type: "issue.created",
      payload: {},
      actorAgentId: null,
      bugId: null,
      tenantId: "tenant-a",
      createdAt: new Date(),
    });

    // Should receive comment.created
    eventStreamBus.broadcast({
      id: "evt-2",
      type: "comment.created",
      payload: { commentId: "c1" },
      actorAgentId: "agent-b",
      bugId: "issue-1",
      tenantId: "tenant-a",
      createdAt: new Date(),
    });

    const { value } = await reader!.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("evt-2");
    expect(text).not.toContain("evt-1");

    reader!.cancel();
  });

  it("filters events by projectId and bugId", async () => {
    const res = await GET(request("/events/stream?bugId=issue-123"));
    const reader = res.body?.getReader();
    await reader!.read();

    eventStreamBus.broadcast({
      id: "evt-1",
      type: "comment.created",
      payload: {},
      actorAgentId: null,
      bugId: "issue-other",
      tenantId: "tenant-a",
      createdAt: new Date(),
    });

    eventStreamBus.broadcast({
      id: "evt-2",
      type: "comment.created",
      payload: {},
      actorAgentId: null,
      bugId: "issue-123",
      tenantId: "tenant-a",
      createdAt: new Date(),
    });

    const { value } = await reader!.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("evt-2");
    expect(text).not.toContain("evt-1");

    reader!.cancel();
  });

  it("respects tenant scoping", async () => {
    const res = await GET(request("/events/stream"));
    const reader = res.body?.getReader();
    await reader!.read();

    eventStreamBus.broadcast({
      id: "evt-1",
      type: "issue.created",
      payload: {},
      actorAgentId: null,
      bugId: null,
      tenantId: "other-tenant",
      createdAt: new Date(),
    });

    // Try to read with timeout - should not get this event
    const readPromise = reader!.read();
    const result = await Promise.race([
      readPromise.then(() => ({ timeout: false as const })),
      new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 100)),
    ]);
    expect(result.timeout).toBe(true);

    reader!.cancel();
  });

  it("sends heartbeat pings", async () => {
    vi.useFakeTimers();
    const res = await GET(request("/events/stream"));
    const reader = res.body?.getReader();
    await reader!.read(); // connected

    await vi.advanceTimersByTimeAsync(15000);
    const { value } = await reader!.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain(": ping");

    reader!.cancel();
  });

  it("cleans up subscription on client abort", async () => {
    const controller = new AbortController();
    const req = new NextRequest(`http://localhost/api/v1/events/stream`, {
      method: "GET",
      headers: { authorization: "Bearer ziki_test-key" },
      signal: controller.signal,
    });

    const res = await GET(req);
    const reader = res.body?.getReader();
    await reader!.read();
    expect(eventStreamBus.subscriptionCount).toBe(1);

    controller.abort();
    // Give time for cleanup
    await new Promise((r) => setTimeout(r, 10));
    expect(eventStreamBus.subscriptionCount).toBe(0);

    try { await reader!.cancel(); } catch {}
  });

  it("only streams events from a project-scoped key's project (#607)", async () => {
    db.agentApiKey.findUnique.mockResolvedValue(scopedKey());
    const res = await GET(request("/events/stream"));
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    await reader!.read(); // connected

    eventStreamBus.broadcast({
      id: "evt-other-project",
      type: "issue.created",
      payload: {},
      actorAgentId: null,
      bugId: "issue-b",
      projectId: "project-b",
      tenantId: "tenant-a",
      createdAt: new Date(),
    });
    eventStreamBus.broadcast({
      id: "evt-no-project",
      type: "goal.created",
      payload: {},
      actorAgentId: null,
      bugId: null,
      tenantId: "tenant-a",
      createdAt: new Date(),
    });
    eventStreamBus.broadcast({
      id: "evt-own-project",
      type: "issue.created",
      payload: {},
      actorAgentId: null,
      bugId: "issue-a",
      projectId: "project-a",
      tenantId: "tenant-a",
      createdAt: new Date(),
    });

    const { value } = await reader!.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("evt-own-project");
    expect(text).not.toContain("evt-other-project");
    expect(text).not.toContain("evt-no-project");

    const second = await Promise.race([
      reader!.read().then(() => ({ timeout: false as const })),
      new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 100)),
    ]);
    expect(second.timeout).toBe(true);
    reader!.cancel();
  });

  it("rejects a foreign projectId for a project-scoped key (#607)", async () => {
    db.agentApiKey.findUnique.mockResolvedValue(scopedKey());
    const res = await GET(request("/events/stream?projectId=project-b"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("project_forbidden");
  });

  it("replays only the project-scoped key's events (#607)", async () => {
    db.agentApiKey.findUnique.mockResolvedValue(scopedKey());
    db.agentEvent.findMany.mockResolvedValue([
      {
        id: "evt-replayed",
        type: "issue.created",
        payload: {},
        actorAgentId: null,
        bugId: "issue-a",
        createdAt: new Date("2026-10-19T12:00:00Z"),
        txid: BigInt(10),
      },
    ]);
    const cursor = encodeEventCursor({ createdAt: new Date("2026-10-19T11:00:00Z"), id: "evt-0" });
    const res = await GET(request(`/events/stream?after=${cursor}`));
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    await reader!.read(); // connected

    const { value } = await reader!.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("evt-replayed");
    expect(db.agentEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-a", projectId: "project-a" }) }),
    );
    reader!.cancel();
  });

  it("validates filters and returns 400 for invalid types", async () => {
    const res = await GET(request("/events/stream?types=invalid.type"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("invalid.type");
  });

  it("replays a multi-page backlog (> 101 events) completely and buffers live events (#478)", async () => {
    const page1 = Array.from({ length: 101 }, (_, i) => ({
      id: `evt-${i + 1}`,
      type: "issue.created",
      payload: { n: i + 1 },
      actorAgentId: null,
      bugId: `issue-${i + 1}`,
      createdAt: new Date("2026-10-19T12:00:00Z"),
      txid: BigInt(100 + i),
    }));
    const page2 = [
      {
        id: "evt-102",
        type: "issue.created",
        payload: { n: 102 },
        actorAgentId: null,
        bugId: "issue-102",
        createdAt: new Date("2026-10-19T12:05:00Z"),
        txid: BigInt(250),
      },
    ];

    db.agentEvent.findMany
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce([]);

    const cursor = encodeEventCursor({ txid: BigInt(50), id: "evt-0" });
    const res = await GET(request(`/events/stream?after=${cursor}`));
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    await reader!.read(); // connected

    // Broadcast a live event while replaying
    eventStreamBus.broadcast({
      id: "evt-live-103",
      type: "issue.created",
      payload: { n: 103 },
      actorAgentId: null,
      bugId: "issue-103",
      tenantId: "tenant-a",
      createdAt: new Date("2026-10-19T12:10:00Z"),
    });

    const receivedIds: string[] = [];
    while (receivedIds.length < 103) {
      const { value, done } = await reader!.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      const matches = text.matchAll(/id: (evt-[a-z0-9-]+)/g);
      for (const match of matches) {
        receivedIds.push(match[1]);
      }
    }

    expect(receivedIds).toContain("evt-1");
    expect(receivedIds).toContain("evt-101");
    expect(receivedIds).toContain("evt-102");
    expect(receivedIds).toContain("evt-live-103");
    expect(receivedIds.length).toBe(103);
    // Historical events 1..102 delivered before live 103
    expect(receivedIds.indexOf("evt-102")).toBeLessThan(receivedIds.indexOf("evt-live-103"));

    reader!.cancel();
  });

  it("handles replay database failures gracefully and still delivers live events (#478)", async () => {
    db.agentEvent.findMany.mockRejectedValueOnce(new Error("Database error"));
    const cursor = encodeEventCursor({ txid: BigInt(50), id: "evt-0" });
    const res = await GET(request(`/events/stream?after=${cursor}`));
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    await reader!.read(); // connected

    eventStreamBus.broadcast({
      id: "evt-live-after-err",
      type: "issue.created",
      payload: {},
      actorAgentId: null,
      bugId: null,
      tenantId: "tenant-a",
      createdAt: new Date(),
    });

    // Let the failed replay promise settle and flush live buffer
    await new Promise((r) => setTimeout(r, 20));

    // #611: the failed replay is reported with an error event, then live events still arrive.
    let text = "";
    while (!text.includes("evt-live-after-err")) {
      const { value, done } = await reader!.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain("event: error");
    expect(text).toContain("Could not replay missed events");
    expect(text).toContain("evt-live-after-err");
    expect(text.indexOf("event: error")).toBeLessThan(text.indexOf("evt-live-after-err"));

    reader!.cancel();
  });

  it("cancels replay loop when the stream reader aborts (#478)", async () => {
    const controller = new AbortController();
    const req = new NextRequest(`http://localhost/api/v1/events/stream?after=${encodeEventCursor({ txid: BigInt(1), id: "e0" })}`, {
      method: "GET",
      headers: { authorization: "Bearer ziki_test-key" },
      signal: controller.signal,
    });

    const page1 = Array.from({ length: 101 }, (_, i) => ({
      id: `evt-${i + 1}`,
      type: "issue.created",
      payload: {},
      actorAgentId: null,
      bugId: null,
      createdAt: new Date(),
      txid: BigInt(10 + i),
    }));
    db.agentEvent.findMany.mockResolvedValue(page1);

    const res = await GET(req);
    const reader = res.body?.getReader();
    await reader!.read(); // connected

    controller.abort();
    await new Promise((r) => setTimeout(r, 20));
    try { await reader!.cancel(); } catch {}

    expect(eventStreamBus.subscriptionCount).toBe(0);
  });
});
