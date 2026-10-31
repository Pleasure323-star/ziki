import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const mock = {
    comment: { findFirst: vi.fn(), findUnique: vi.fn() },
    commentVote: { createMany: vi.fn(), count: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  mock.$transaction.mockImplementation((fn: (tx: typeof mock) => unknown) => fn(mock));
  return mock;
});
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/events", () => ({ publish: vi.fn(async () => ({ id: "evt" })) }));
vi.mock("@/lib/agents/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/points/award", () => ({ award: vi.fn(async () => true) }));

import { publish } from "@/lib/agent-api/events";
import { audit } from "@/lib/agents/audit";
import { award } from "@/lib/points/award";
import { castCommentVote, upvoteComment } from "./comment-votes";

const eli = {
  agentId: "eli-agent",
  name: "Eli's Claude",
  ownerId: "eli",
  tenantId: "tenant",
  level: "working" as const,
  burst: false,
  keyId: "key1",
};

const found = { id: "c1", bugId: "issue1" };
const openComment = {
  id: "c1", bugId: "issue1", authorId: "bob", agentId: "bob-agent", deletedAt: null,
  confirmationId: null, bidId: null, deliveryId: null, testVerdictId: null, mergeReviewId: null,
  agent: { ownerUserId: "bob" },
  bug: { number: 7, status: "open", substatus: "open", tenantId: "tenant", projectId: "project", isDeleted: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  db.$queryRaw.mockResolvedValue([{ id: "issue1" }]);
  db.comment.findFirst.mockResolvedValue(found);
  db.comment.findUnique.mockResolvedValue(openComment);
  db.commentVote.createMany.mockResolvedValue({ count: 1 });
  db.commentVote.count.mockResolvedValue(1);
});

describe("upvoteComment (#comment-votes)", () => {
  it("records one vote for the voter's owner, pays the author 1 point, publishes and audits it", async () => {
    await expect(upvoteComment(eli, "project", "c1")).resolves.toEqual({ commentId: "c1", votes: 1 });
    expect(db.comment.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "c1", bug: { tenantId: "tenant", projectId: "project", isDeleted: false } },
    }));
    expect(db.commentVote.createMany).toHaveBeenCalledWith({
      data: [{ commentId: "c1", bugId: "issue1", onBehalfOfUserId: "eli", agentId: "eli-agent" }],
      skipDuplicates: true,
    });
    expect(award).toHaveBeenCalledWith(db, {
      tenantId: "tenant",
      userId: "bob",
      bugId: "issue1",
      role: "comment",
      points: 1,
      sourceKey: "comment-upvote:c1:eli",
    });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      type: "issue.comment_upvoted",
      actorAgentId: "eli-agent",
      payload: expect.objectContaining({ commentId: "c1", issueId: "issue1", issueNumber: 7, authorId: "bob", votes: 1 }),
    }));
    expect(audit).toHaveBeenCalledWith(eli, "issue.comment_upvoted", "issue:issue1", { commentId: "c1", votes: 1 }, { bugId: "issue1" });
  });

  it("is idempotent: voting again counts once, pays nothing more and publishes nothing new", async () => {
    db.commentVote.createMany.mockResolvedValue({ count: 0 });
    db.commentVote.count.mockResolvedValue(2);
    await expect(upvoteComment(eli, "project", "c1")).resolves.toEqual({ commentId: "c1", votes: 2 });
    expect(award).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses the owner's own comment with 403 own_comment, as author or as the authoring agent's owner", async () => {
    for (const comment of [{ ...openComment, authorId: "eli", agent: null }, { ...openComment, agent: { ownerUserId: "eli" } }]) {
      db.comment.findUnique.mockResolvedValueOnce(comment);
      await expect(upvoteComment(eli, "project", "c1")).rejects.toMatchObject({
        status: 403,
        body: expect.objectContaining({ error: "own_comment" }),
      });
    }
    expect(db.commentVote.createMany).not.toHaveBeenCalled();
    expect(award).not.toHaveBeenCalled();
  });

  it("refuses a comment on an issue that is not Open, and a reply under a stage entry, with 409", async () => {
    for (const comment of [
      { ...openComment, bug: { ...openComment.bug, status: "in_progress", substatus: "in_progress" } },
      { ...openComment, bidId: "bid1" },
      { ...openComment, testVerdictId: "tv1" },
    ]) {
      db.comment.findUnique.mockResolvedValueOnce(comment);
      await expect(upvoteComment(eli, "project", "c1")).rejects.toMatchObject({ status: 409 });
    }
    expect(db.commentVote.createMany).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown comment, outside the project, or deleted", async () => {
    db.comment.findFirst.mockResolvedValueOnce(null);
    await expect(upvoteComment(eli, "project", "c1")).rejects.toMatchObject({ status: 404 });
    expect(db.$transaction).not.toHaveBeenCalled();

    db.comment.findUnique.mockResolvedValueOnce({ ...openComment, deletedAt: new Date() });
    await expect(upvoteComment(eli, "project", "c1")).rejects.toMatchObject({ status: 404 });
    expect(db.commentVote.createMany).not.toHaveBeenCalled();
  });

  it("refuses a key restricted to another project", async () => {
    await expect(upvoteComment({ ...eli, projectId: "key-project" }, "project", "c1")).rejects.toThrow("restricted");
    expect(db.comment.findFirst).not.toHaveBeenCalled();
  });
});

describe("castCommentVote for a person (#comment-votes)", () => {
  it("records the person's own vote with no agent, and names them as the actor", async () => {
    await expect(castCommentVote({ commentId: "c1", bugScope: { tenantId: "tenant" }, voterUserId: "eli", agentId: null }))
      .resolves.toMatchObject({ commentId: "c1", votes: 1, created: true });
    expect(db.commentVote.createMany).toHaveBeenCalledWith({
      data: [{ commentId: "c1", bugId: "issue1", onBehalfOfUserId: "eli", agentId: null }],
      skipDuplicates: true,
    });
    expect(publish).toHaveBeenCalledWith(db, expect.objectContaining({
      actorAgentId: null,
      payload: expect.objectContaining({ actor: { type: "user", id: "eli" } }),
    }));
  });
});
