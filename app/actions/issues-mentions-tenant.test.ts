import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #502: @mentions on a new issue and a new comment resolve only to members
 * of the issue's tenant. Anyone else stays plain text and is never notified.
 */

const publishWebEvent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/agent-api/web-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-api/web-events")>()),
  publishWebEvent,
}));
vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor: vi.fn(async () => "tenant-zedu"),
  defaultProjectIdFor: vi.fn(async () => "project-zedu"),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notifyLater: vi.fn() }));
vi.mock("@/lib/watch", () => ({ ensureWatching: vi.fn(async () => undefined) }));
vi.mock("@/lib/attachment-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/attachment-link")>()),
  linkAttachments: vi.fn(async () => 0),
}));
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: vi.fn(async () => ({ userId: "alice" })),
  SESSION_EXPIRED_MESSAGE: "Session expired, sign in again",
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireUser: vi.fn(async () => ({ id: "alice", name: "Alice", role: "user" })),
}));
vi.mock("@/lib/tenant-access", () => ({
  currentTenantAccess: vi.fn(async () => ({
    tenantId: "tenant-zedu",
    tenantName: "Zedu",
    tenantSlug: "zedu",
    membershipRole: "member",
    admin: false,
  })),
}));

const bob = "clxxxxxxxxxxxxxxxxxxxxxxxx2";
const dave = "clxxxxxxxxxxxxxxxxxxxxxxxx4";

vi.mock("@/lib/prisma", () => {
  const tx = {
    comment: { create: vi.fn(async () => ({ id: "comment-new" })) },
    bugActivity: { create: vi.fn() },
    bug: { update: vi.fn() },
    idea: { create: vi.fn() },
  };
  return {
    prisma: {
      bug: { findUnique: vi.fn(), create: vi.fn() },
      comment: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
      issueBid: { findFirst: vi.fn() },
      testVerdict: { findFirst: vi.fn() },
      mergeReview: { findFirst: vi.fn() },
      user: {
        findUnique: vi.fn(async () => ({ name: "Alice" })),
        // Bob is in Zedu, the issue's tenant; Dave is only in Acme.
        findMany: vi.fn(
          async ({ where }: { where: { id: { in: string[] }; memberships?: { some: { tenantId: string } } } }) =>
            [
              { id: "clxxxxxxxxxxxxxxxxxxxxxxxx2", name: "Bob", tenant: "tenant-zedu" },
              { id: "clxxxxxxxxxxxxxxxxxxxxxxxx4", name: "Dave Acme", tenant: "tenant-acme" },
            ]
              .filter((u) => where.id.in.includes(u.id) && u.tenant === where.memberships?.some.tenantId)
              .map(({ id, name }) => ({ id, name })),
        ),
      },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      __tx: tx,
    },
  };
});

import { prisma } from "@/lib/prisma";
import { notifyLater } from "@/lib/notify";
import { resetRateLimits } from "@/lib/rate-limit";
import { addCommentAction, createBugAction } from "./issues";

const db = prisma as unknown as {
  bug: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  user: { findMany: ReturnType<typeof vi.fn> };
  issueBid: { findFirst: ReturnType<typeof vi.fn> };
  testVerdict: { findFirst: ReturnType<typeof vi.fn> };
  mergeReview: { findFirst: ReturnType<typeof vi.fn> };
  __tx: { comment: { create: ReturnType<typeof vi.fn> } };
};
const notifyMock = vi.mocked(notifyLater);

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  db.bug.findUnique.mockResolvedValue({
    id: "bug-1",
    isDeleted: false,
    title: "Bug list filter resets after navigation",
    reporterId: "carol",
    assigneeId: null,
    tenantId: "tenant-zedu",
    convertedToIssueAt: new Date("2026-10-19T13:00:00Z"),
  });
});

describe("addCommentAction (#502)", () => {
  it("doesn't notify someone from another tenant, and stores their tag as plain text", async () => {
    const result = await addCommentAction("bug-1", form({ body: `ping @[Dave Acme](${dave}) and @[Bob](${bob})` }));

    expect(result).toEqual({ ok: true, commentId: "comment-new" });
    expect(db.user.findMany.mock.calls[0][0].where.memberships).toEqual({ some: { tenantId: "tenant-zedu" } });
    expect(db.__tx.comment.create.mock.calls[0][0].data.body).toBe(`ping @Dave Acme and @[Bob](${bob})`);
    const events = notifyMock.mock.calls[0]!;
    const mentioned = events.find((event) => event.kind === "mentioned");
    expect(mentioned).toMatchObject({ recipientIds: [bob] });
    expect(JSON.stringify(events)).not.toContain(dave);
  });

  it("sends no mention at all when the only tag is outside the tenant", async () => {
    await addCommentAction("bug-1", form({ body: `ping @[Dave Acme](${dave})` }));
    const events = notifyMock.mock.calls[0]!;
    expect(events.some((event) => event.kind === "mentioned")).toBe(false);
    expect(JSON.stringify(events)).not.toContain(dave);
  });
});

describe("createBugAction (#502)", () => {
  it("resolves description mentions against the reporter's tenant", async () => {
    const ideaCreate = (prisma as unknown as { __tx: { idea: { create: ReturnType<typeof vi.fn> } } }).__tx.idea.create;
    ideaCreate.mockRejectedValue(new Error("stop after create"));
    await createBugAction(
      form({
        title: "Bug list filter resets after navigation",
        description: `Filters reset when I go back to the list. cc @[Dave Acme](${dave}) @[Bob](${bob})`,
        proofLinks: "",
      }),
    ).catch(() => undefined);

    expect(ideaCreate).toHaveBeenCalledTimes(1);
    expect(ideaCreate.mock.calls[0][0].data.description).toBe(
      `Filters reset when I go back to the list. cc @Dave Acme @[Bob](${bob})`,
    );
    expect(db.user.findMany.mock.calls[0][0].where.memberships).toEqual({ some: { tenantId: "tenant-zedu" } });
  });
});

describe("addCommentAction replies to a bid (#issue-bids)", () => {
  it("files a plain comment under the bid and notifies its owner", async () => {
    db.issueBid.findFirst.mockResolvedValue({ beneficiaryUserId: bob });
    const result = await addCommentAction("bug-1", form({ body: "Please add a test.", bidId: "bid-1" }));
    expect(result).toEqual({ ok: true, commentId: "comment-new" });
    expect(db.issueBid.findFirst).toHaveBeenCalledWith({ where: { id: "bid-1", bugId: "bug-1" }, select: { beneficiaryUserId: true } });
    expect(db.__tx.comment.create.mock.calls[0][0].data).toMatchObject({ bidId: "bid-1", parentId: null, confirmationId: null, type: "comment" });
  });

  it("refuses a bid on another issue, and a typed or nested reply", async () => {
    db.issueBid.findFirst.mockResolvedValue(null);
    expect(await addCommentAction("bug-1", form({ body: "Hi.", bidId: "bid-x" }))).toEqual({ error: "That bid is not on this issue" });
    db.issueBid.findFirst.mockResolvedValue({ beneficiaryUserId: bob });
    expect(await addCommentAction("bug-1", form({ body: "Hi.", bidId: "bid-1", type: "review" }))).toEqual({ error: "A reply to a bid is a plain comment" });
    expect(db.__tx.comment.create).not.toHaveBeenCalled();
  });
});

describe("addCommentAction replies to a test verdict or a merge review (#review-entries)", () => {
  it("files a plain comment under the test verdict", async () => {
    db.testVerdict.findFirst.mockResolvedValue({ onBehalfOfUserId: bob });
    const result = await addCommentAction("bug-1", form({ body: "Which browser?", testVerdictId: "tv-1" }));
    expect(result).toEqual({ ok: true, commentId: "comment-new" });
    expect(db.testVerdict.findFirst).toHaveBeenCalledWith({ where: { id: "tv-1", bugId: "bug-1" }, select: { onBehalfOfUserId: true } });
    expect(db.__tx.comment.create.mock.calls[0][0].data).toMatchObject({ testVerdictId: "tv-1", mergeReviewId: null, parentId: null, type: "comment" });
  });

  it("files a plain comment under the merge review", async () => {
    db.mergeReview.findFirst.mockResolvedValue({ onBehalfOfUserId: bob });
    const result = await addCommentAction("bug-1", form({ body: "Fixed in the next commit.", mergeReviewId: "mr-1" }));
    expect(result).toEqual({ ok: true, commentId: "comment-new" });
    expect(db.__tx.comment.create.mock.calls[0][0].data).toMatchObject({ mergeReviewId: "mr-1", testVerdictId: null, parentId: null });
  });

  it("refuses an entry on another issue, a typed reply, and two entries at once", async () => {
    db.testVerdict.findFirst.mockResolvedValue(null);
    expect(await addCommentAction("bug-1", form({ body: "Hi.", testVerdictId: "tv-x" }))).toEqual({ error: "That test verdict is not on this issue" });
    db.mergeReview.findFirst.mockResolvedValue({ onBehalfOfUserId: bob });
    expect(await addCommentAction("bug-1", form({ body: "Hi.", mergeReviewId: "mr-1", type: "review" }))).toEqual({ error: "A reply to a merge review is a plain comment" });
    expect(await addCommentAction("bug-1", form({ body: "Hi.", mergeReviewId: "mr-1", testVerdictId: "tv-1" }))).toEqual({ error: "Reply to one entry at a time" });
    expect(db.__tx.comment.create).not.toHaveBeenCalled();
  });
});
