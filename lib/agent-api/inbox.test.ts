import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  agentInboxItem: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
const markMessagesRead = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-messages", () => ({ markMessagesRead }));

import { inboxRecipients, listInbox, markInboxRead, markInboxReadSchema, pollInbox, serializeInboxItem, writeInbox, type InboxEvent } from "./inbox";
import { publish } from "./events";

/** A transaction double with every table the inbox routing reads. */
function tx(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    agentEvent: { create: vi.fn().mockResolvedValue({ id: "event-1" }) },
    webhookSubscription: { findMany: vi.fn().mockResolvedValue([]) },
    webhookDelivery: { createMany: vi.fn() },
    agentInboxItem: { createMany: vi.fn().mockImplementation(({ data }) => ({ count: data.length })) },
    agent: { findMany: vi.fn().mockImplementation(({ where }) => (where.id?.in ?? []).map((id: string) => ({ id }))) },
    issueClaim: { findUnique: vi.fn().mockResolvedValue({ agentId: "agent-bob" }) },
    comment: { findUnique: vi.fn() },
    bug: { findUnique: vi.fn() },
    redesignProposal: { findUnique: vi.fn() },
    ...overrides,
  };
}
type Tx = ReturnType<typeof tx>;
const run = (t: Tx, event: Omit<InboxEvent, "id" | "tenantId"> & { tenantId?: string }) =>
  inboxRecipients(t as never, { id: "event-1", tenantId: "tenant-a", ...event });

const mention = (userId: string) => `hi @[Owner](${userId})`;
const item = { id: "item-1", kind: "offer", eventId: "event-1", eventType: "claim.offered", bugId: "bug-1", commentId: null,
  payload: { claimId: "claim-1" }, readAt: null, createdAt: new Date("2026-10-20T10:00:00Z") };

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe("inbox routing", () => {
  it("gives an offer only to the agent it was made to", async () => {
    const t = tx();
    await publish(t as never, { tenantId: "tenant-a", type: "claim.offered", actorAgentId: "agent-alice", bugId: "bug-1",
      payload: { claimId: "claim-1", issueId: "bug-1" } });
    expect(t.issueClaim.findUnique).toHaveBeenCalledWith({ where: { id: "claim-1" }, select: { agentId: true } });
    expect(t.agentInboxItem.createMany).toHaveBeenCalledWith({ skipDuplicates: true, data: [expect.objectContaining({
      agentId: "agent-bob", kind: "offer", eventId: "event-1", eventType: "claim.offered", bugId: "bug-1",
    })] });
    expect(await run(tx(), { type: "review.requested", payload: { offerId: "o", agentId: "agent-carol" } }))
      .toEqual([{ agentId: "agent-carol", kind: "offer" }]);
  });

  it("delivers a job review offer with the context needed to accept it", async () => {
    const event = {
      id: "job-review-event",
      tenantId: "tenant-a",
      type: "job.review.requested",
      payload: {
        offerId: "job-review-offer",
        jobId: "job-1",
        submissionId: "submission-1",
        agentId: "agent-carol",
        beneficiaryUserId: "carol",
        expiresAt: "2026-10-20T10:01:00.000Z",
      },
    } satisfies InboxEvent;

    expect(await run(tx(), { type: event.type, payload: event.payload }))
      .toEqual([{ agentId: "agent-carol", kind: "offer" }]);

    const t = tx();
    expect(await writeInbox(t as never, event)).toBe(1);
    expect(t.agentInboxItem.createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: [expect.objectContaining({
        agentId: "agent-carol",
        kind: "offer",
        eventId: "job-review-event",
        eventType: "job.review.requested",
        bugId: null,
        payload: event.payload,
      })],
    });
  });

  it("puts a reply to an agent's comment in that agent's inbox", async () => {
    const t = tx();
    t.comment.findUnique.mockResolvedValue({ agentId: null, body: "thanks", parent: { agentId: "agent-bob" } });
    expect(await run(t, { type: "comment.created", payload: { commentId: "c2", parentId: "c1" } }))
      .toEqual([{ agentId: "agent-bob", kind: "reply", commentId: "c2" }]);
  });

  it("puts a reply to an agent's entry in that agent's inbox (#entry-replies-only)", async () => {
    const t = tx();
    t.comment.findUnique.mockResolvedValue({ agentId: null, body: "Please add a test.", parent: null, bid: { agentId: "agent-eli" } });
    expect(await run(t, { type: "comment.created", payload: { commentId: "c5" } }))
      .toEqual([{ agentId: "agent-eli", kind: "reply", commentId: "c5" }]);
  });

  it("does not notify an agent of its own reply or of replies to people", async () => {
    const t = tx();
    t.comment.findUnique.mockResolvedValueOnce({ agentId: "agent-bob", body: "x", parent: { agentId: "agent-bob" } })
      .mockResolvedValueOnce({ agentId: null, body: "x", parent: { agentId: null } });
    expect(await run(t, { type: "comment.created", payload: { commentId: "c2" } })).toEqual([]);
    expect(await run(t, { type: "comment.created", payload: { commentId: "c3" } })).toEqual([]);
  });

  it("delivers a mention of the owner to the owner's agents, except the author", async () => {
    const t = tx({ agent: { findMany: vi.fn().mockResolvedValue([{ id: "agent-bob" }, { id: "agent-author" }]) } });
    t.comment.findUnique.mockResolvedValue({ agentId: "agent-author", body: mention("bob"), parent: null });
    expect(await run(t, { type: "comment.created", payload: { commentId: "c1" } }))
      .toEqual([{ agentId: "agent-bob", kind: "mention", commentId: "c1" }]);
    expect(t.agent.findMany).toHaveBeenCalledWith({ where: { tenantId: "tenant-a", revokedAt: null, ownerUserId: { in: ["bob"] } }, select: { id: true } });
  });

  it("delivers a mention of an agent by name to that agent (#603)", async () => {
    const t = tx();
    t.comment.findUnique.mockResolvedValue({ agentId: null, body: "@[Mark's Claude](agent:agent-mark) retest?", parent: null });
    expect(await run(t, { type: "comment.created", payload: { commentId: "c1" } }))
      .toEqual([{ agentId: "agent-mark", kind: "mention", commentId: "c1" }]);
    expect(t.agent.findMany).not.toHaveBeenCalled();
  });

  it("writes no item for a mentioned agent outside the event's tenant (#603)", async () => {
    const t = tx({ agent: { findMany: vi.fn().mockResolvedValue([]) } });
    t.comment.findUnique.mockResolvedValue({ agentId: null, body: "@[Other](agent:agent-elsewhere)", parent: null });
    expect(await writeInbox(t as never, { id: "event-1", tenantId: "tenant-a", type: "comment.created", bugId: "bug-1", payload: { commentId: "c1" } })).toBe(0);
    expect(t.agent.findMany).toHaveBeenLastCalledWith({ where: { id: { in: ["agent-elsewhere"] }, tenantId: "tenant-a", revokedAt: null }, select: { id: true } });
    expect(t.agentInboxItem.createMany).not.toHaveBeenCalled();
  });

  it("delivers a mention in a new idea's description (#idea-table)", async () => {
    const t = tx({
      agent: { findMany: vi.fn().mockResolvedValue([{ id: "agent-bob" }]) },
      idea: { findUnique: vi.fn().mockResolvedValue({ description: mention("bob") }) },
    });
    expect(await run(t, { type: "idea.created", payload: { ideaId: "idea-1" } }))
      .toEqual([{ agentId: "agent-bob", kind: "mention", commentId: null }]);
  });

  it("routes answers, decisions and claim releases", async () => {
    const t = tx();
    expect(await run(t, { type: "question.answered", payload: { questionId: "q", agentId: "agent-bob" } }))
      .toEqual([{ agentId: "agent-bob", kind: "answer" }]);
    t.redesignProposal.findUnique.mockResolvedValue({ authorAgentId: "agent-bob" });
    expect(await run(t, { type: "redesign.rejected", payload: { proposalId: "p" } })).toEqual([{ agentId: "agent-bob", kind: "approval" }]);
    t.issueClaim.findUnique.mockResolvedValue({ agentId: "agent-bob" });
    expect(await run(t, { type: "issue.bid_awarded", payload: { claimId: "c" } })).toEqual([{ agentId: "agent-bob", kind: "approval" }]);
    expect(await run(t, { type: "claim.released", payload: { claimId: "c", reason: "silence" } })).toEqual([{ agentId: "agent-bob", kind: "claim" }]);
    for (const reason of ["declined", "agent", "revoked"]) {
      expect(await run(t, { type: "claim.released", payload: { claimId: "c", reason } })).toEqual([]);
    }
    expect(await run(t, { type: "issue.updated", payload: {} })).toEqual([]);
  });

  it("writes one item per agent and skips revoked or out-of-tenant agents", async () => {
    const t = tx({ agent: { findMany: vi.fn()
      .mockResolvedValueOnce([{ id: "agent-bob" }, { id: "agent-gone" }])
      .mockResolvedValueOnce([{ id: "agent-bob" }]) } });
    t.comment.findUnique.mockResolvedValue({ agentId: null, body: mention("bob"), parent: { agentId: "agent-bob" } });
    t.agentInboxItem.createMany.mockResolvedValue({ count: 1 });
    expect(await writeInbox(t as never, { id: "event-1", tenantId: "tenant-a", type: "comment.created", bugId: "bug-1", payload: { commentId: "c2" } })).toBe(1);
    expect(t.agent.findMany).toHaveBeenLastCalledWith({ where: { id: { in: ["agent-bob", "agent-gone"] }, tenantId: "tenant-a", revokedAt: null }, select: { id: true } });
    expect(t.agentInboxItem.createMany.mock.calls[0][0].data).toEqual([expect.objectContaining({ agentId: "agent-bob", kind: "reply", commentId: "c2" })]);
  });

  it("is a no-op for a client without the inbox table", async () => {
    const t = tx({ agentInboxItem: undefined });
    expect(await writeInbox(t as never, { id: "e", tenantId: "t", type: "claim.offered", payload: { claimId: "c" } })).toBe(0);
    expect(t.issueClaim.findUnique).not.toHaveBeenCalled();
  });
});

describe("inbox reads", () => {
  it("lists only this agent's items, optionally unread, after a cursor", async () => {
    db.agentInboxItem.findMany.mockResolvedValue([]);
    const cursor = { createdAt: item.createdAt, id: "item-1" };
    await listInbox({ agentId: "agent-bob" }, cursor, { unread: true });
    expect(db.agentInboxItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      agentId: "agent-bob", readAt: null,
      OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: "item-1" } }],
    }, take: 101 }));
  });

  it("long-polls and returns as soon as an item arrives", async () => {
    vi.useFakeTimers();
    db.agentInboxItem.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([item]);
    let settled = false;
    const pending = pollInbox({ agentId: "agent-bob" }, null, 25).then((rows) => { settled = true; return rows; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual([item]);
    expect(db.agentInboxItem.findMany).toHaveBeenCalledTimes(2);
  });

  it("links an item to its comment or issue", () => {
    expect(serializeInboxItem(item)).toMatchObject({ kind: "offer", issueId: "bug-1", read: false, readAt: null, createdAt: "2026-10-20T10:00:00.000Z" });
    expect(serializeInboxItem(item).url).toMatch(/\/issues\/bug-1$/);
    expect(serializeInboxItem({ ...item, commentId: "c1" }).url).toMatch(/\/issues\/bug-1\?comment=c1#comment-c1$/);
    expect(serializeInboxItem({ ...item, bugId: null }).url).toBeNull();
  });
});

describe("marking items read", () => {
  it("marks listed ids of this agent only", async () => {
    db.agentInboxItem.updateMany.mockResolvedValue({ count: 2 });
    expect(await markInboxRead({ agentId: "agent-bob" }, { ids: ["a", "b"] })).toBe(2);
    expect(db.agentInboxItem.updateMany).toHaveBeenCalledWith({
      where: { agentId: "agent-bob", id: { in: ["a", "b"] }, readAt: null }, data: { readAt: expect.any(Date) },
    });
  });

  it("marks everything up to an item, and 404s an unknown anchor", async () => {
    db.agentInboxItem.findFirst.mockResolvedValueOnce({ id: "item-1", createdAt: item.createdAt }).mockResolvedValueOnce(null);
    db.agentInboxItem.updateMany.mockResolvedValue({ count: 3 });
    expect(await markInboxRead({ agentId: "agent-bob" }, { upTo: "item-1" })).toBe(3);
    expect(db.agentInboxItem.updateMany.mock.calls[0][0].where).toEqual({ agentId: "agent-bob", readAt: null,
      OR: [{ createdAt: { lt: item.createdAt } }, { createdAt: item.createdAt, id: { lte: "item-1" } }] });
    expect(await markInboxRead({ agentId: "agent-bob" }, { upTo: "other-agents-item" })).toBeNull();
  });

  it("marks the owner's messages behind the items read (#605)", async () => {
    db.agentInboxItem.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await markInboxRead({ agentId: "agent-bob" }, { ids: ["a"] });
    const readAt = db.agentInboxItem.updateMany.mock.calls[0][0].data.readAt;
    expect(markMessagesRead).toHaveBeenCalledWith("agent-bob", readAt);
    await markInboxRead({ agentId: "agent-bob" }, { ids: ["b"] });
    expect(markMessagesRead).toHaveBeenCalledTimes(1);
  });

  it("accepts ids or upTo, not both or neither", () => {
    expect(markInboxReadSchema.safeParse({ ids: ["a"] }).success).toBe(true);
    expect(markInboxReadSchema.safeParse({ upTo: "a" }).success).toBe(true);
    for (const body of [{}, { ids: [] }, { ids: ["a"], upTo: "a" }, { upTo: "" }]) {
      expect(markInboxReadSchema.safeParse(body).success).toBe(false);
    }
  });
});
