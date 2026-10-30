import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { issueChangePayload, publishWebEvent } from "./web-events";

function fakeDb(bug: { tenantId: string; projectId: string } | null) {
  return {
    bug: { findUnique: vi.fn(async () => bug) },
    user: { findUnique: vi.fn(async () => ({ name: "Alice Mentor" })) },
    agentEvent: { create: vi.fn(async () => ({ id: "evt-1" })) },
    webhookSubscription: { findMany: vi.fn(async () => []) },
    webhookDelivery: { createMany: vi.fn(async () => ({ count: 0 })) },
  };
}

describe("publishWebEvent (#600)", () => {
  it("writes an agent event for a person's comment, in the issue's tenant", async () => {
    const db = fakeDb({ tenantId: "tenant-zedu", projectId: "project-web" });

    await publishWebEvent(db as never, {
      bugId: "bug-2",
      type: "comment.created",
      actorUserId: "alice",
      payload: { commentId: "c-9", parentId: "c-1", authorId: "alice" },
    });

    expect(db.agentEvent.create).toHaveBeenCalledWith({
      data: {
        tenantId: "tenant-zedu",
        type: "comment.created",
        actorAgentId: null,
        bugId: "bug-2",
        payload: {
          issueId: "bug-2",
          projectId: "project-web",
          commentId: "c-9",
          parentId: "c-1",
          authorId: "alice",
          actor: { type: "user", id: "alice", name: "Alice Mentor" },
        },
      },
      select: { id: true },
    });
  });

  it("does nothing for an issue that no longer exists", async () => {
    const db = fakeDb(null);
    await publishWebEvent(db as never, { bugId: "gone", type: "issue.deleted", actorUserId: "alice" });
    expect(db.agentEvent.create).not.toHaveBeenCalled();
  });

  it("can't be spoofed as an agent through the payload", async () => {
    const db = fakeDb({ tenantId: "t", projectId: "p" });
    await publishWebEvent(db as never, {
      bugId: "b",
      type: "comment.created",
      actorUserId: "alice",
      payload: { actor: { type: "agent", id: "x" } },
    });
    const [call] = db.agentEvent.create.mock.calls[0] as unknown as [{ data: { payload: { actor: unknown } } }];
    expect(call.data.payload.actor).toEqual({ type: "user", id: "alice", name: "Alice Mentor" });
  });
});

describe("issueChangePayload (#600)", () => {
  it("names what changed and gives the triage values", () => {
    expect(
      issueChangePayload({ status: "resolved", typeId: "type-fix", assigneeId: null, updatedAt: new Date() }),
    ).toEqual({
      changed: ["assigneeId", "status", "typeId"],
      values: { status: "resolved", typeId: "type-fix", assigneeId: null },
    });
  });

  it("names a description edit without copying the text", () => {
    expect(issueChangePayload({ description: "long text" })).toEqual({ changed: ["description"], values: {} });
  });
});
