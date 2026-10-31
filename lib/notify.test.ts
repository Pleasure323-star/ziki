import { beforeEach, describe, expect, it, vi } from "vitest";

/** Opt-out filtering, per-recipient isolation and dedupe in notifications (#218). */

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(), canSendMail: vi.fn(() => true) }));
// bug / notification / issueWatch are used once notifications also have an
// in-app feed and watchers (#216); harmless before that.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findMany: vi.fn() },
    bug: { findUnique: vi.fn(async () => ({
      isDeleted: false,
      assigneeId: null,
      tenantId: "tenant-1",
      number: 12,
      project: { slug: "ziki" },
    })) },
    notification: { createMany: vi.fn() },
    issueWatch: { findMany: vi.fn(async () => []) },
  },
}));

import { prisma } from "@/lib/prisma";
import { sendMail } from "@/lib/mail";
import {
  DEFAULT_SMTP_CONCURRENCY,
  deliverNotifications,
  getSmtpConcurrency,
  mapConcurrent,
} from "./notify";

const findMany = prisma.user.findMany as unknown as ReturnType<typeof vi.fn>;
const send = sendMail as unknown as ReturnType<typeof vi.fn>;

const base = { actorId: "actor", actorName: "Alice", bugId: "b1", bugTitle: "Broken button" };

/** A recipient who wants every kind of mail, unless told otherwise. */
const who = (id: string, over: Record<string, boolean> = {}) => ({
  id,
  email: `${id}@x.dev`,
  emailNotifications: true,
  notifyMentions: true,
  notifyAssignments: true,
  notifyStatusChanges: true,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("deliverNotifications", () => {
  it("does not notify a parent author who explicitly unwatched the issue (#738)", async () => {
    const issueWatchFindMany = prisma.issueWatch.findMany as unknown as ReturnType<typeof vi.fn>;
    issueWatchFindMany.mockResolvedValue([{ userId: "bob", watching: false }]);
    findMany.mockResolvedValue([who("bob")]);

    await deliverNotifications({
      ...base,
      kind: "comment_added",
      commentId: "c1",
      parentAuthorId: "bob",
      recipientIds: [],
    });

    expect(prisma.notification.createMany as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("still notifies an actively watching parent author about replies (#738)", async () => {
    const issueWatchFindMany = prisma.issueWatch.findMany as unknown as ReturnType<typeof vi.fn>;
    issueWatchFindMany.mockResolvedValue([{ userId: "bob", watching: true }]);
    findMany.mockResolvedValue([who("bob")]);

    await deliverNotifications({
      ...base,
      kind: "comment_added",
      commentId: "c1",
      parentAuthorId: "bob",
      recipientIds: [],
    });

    expect(prisma.notification.createMany as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    const call = (prisma.notification.createMany as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.map((row: { userId: string }) => row.userId)).toEqual(["bob"]);
    expect(call.data.map((row: { tenantId: string }) => row.tenantId)).toEqual(["tenant-1"]);
    expect(call.data.map((row: { url: string }) => row.url)).toEqual(["/ziki/12?comment=c1#comment-c1"]);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].to).toBe("bob@x.dev");
  });

  it("keeps a tenant invite out of the destination workspace", async () => {
    findMany.mockResolvedValue([who("cara")]);
    await deliverNotifications({
      kind: "tenant_invite",
      actorId: "alice",
      actorName: "Alice",
      recipientId: "cara",
      tenantId: "tenant-ziki",
      inviteId: "invite-1",
      tenantName: "Ziki",
    });

    const call = (prisma.notification.createMany as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call.data).toEqual([expect.objectContaining({ userId: "cara", tenantId: null, kind: "tenant_invite" })]);
  });

  it("stores the workspace for notifications without an issue link", async () => {
    findMany.mockResolvedValue([]);
    await deliverNotifications({
      kind: "agent_question",
      actorId: null,
      actorName: "Claude",
      recipientId: "bob",
      tenantId: "tenant-2",
      questionId: "question-1",
    });

    const call = (prisma.notification.createMany as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call.data).toEqual([expect.objectContaining({ userId: "bob", tenantId: "tenant-2" })]);
  });

  it("only emails people who haven't opted out", async () => {
    findMany.mockResolvedValue([who("bob")]);
    await deliverNotifications({ ...base, kind: "mentioned", recipientIds: ["bob", "cara"], place: "comment" });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ emailNotifications: true }) }),
    );
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].to).toBe("bob@x.dev");
  });

  it("keeps sending to others when one recipient fails", async () => {
    findMany.mockResolvedValue([who("bob"), who("cara")]);
    send.mockRejectedValueOnce(new Error("SMTP 550")).mockResolvedValueOnce(undefined);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      deliverNotifications({ ...base, kind: "mentioned", recipientIds: ["bob", "cara"], place: "comment" }),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("skips a recipient who switched off that kind of email", async () => {
    findMany.mockResolvedValue([
      who("bob", { notifyMentions: false }),
      who("cara"),
    ]);
    await deliverNotifications({ ...base, kind: "mentioned", recipientIds: ["bob", "cara"], place: "comment" });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].to).toBe("cara@x.dev");
  });

  it("still sends the kinds that recipient kept", async () => {
    findMany.mockResolvedValue([who("bob", { notifyMentions: false })]);
    await deliverNotifications({
      ...base,
      kind: "assignee_changed",
      fromUserId: null,
      toUserId: "bob",
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].to).toBe("bob@x.dev");
  });

  it("never emails the person who acted, and skips the query when nobody's left", async () => {
    await deliverNotifications({ ...base, kind: "mentioned", recipientIds: ["actor"], place: "comment" });
    expect(findMany).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("limits concurrent SMTP sends to the configured concurrency limit (#354)", async () => {
    const users = Array.from({ length: 6 }, (_, i) => who(`user${i}`));
    findMany.mockResolvedValue(users);

    let inFlight = 0;
    let peakInFlight = 0;
    send.mockImplementation(async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    });

    const previousSmtp = process.env.SMTP_MAX_CONCURRENCY;
    const previousEmail = process.env.EMAIL_CONCURRENCY;
    process.env.SMTP_MAX_CONCURRENCY = String(DEFAULT_SMTP_CONCURRENCY);
    delete process.env.EMAIL_CONCURRENCY;

    try {
      await deliverNotifications({
        ...base,
        kind: "mentioned",
        recipientIds: users.map((u) => u.id),
        place: "comment",
      });

      expect(send).toHaveBeenCalledTimes(6);
      expect(peakInFlight).toBeLessThanOrEqual(DEFAULT_SMTP_CONCURRENCY);
    } finally {
      if (previousSmtp === undefined) delete process.env.SMTP_MAX_CONCURRENCY;
      else process.env.SMTP_MAX_CONCURRENCY = previousSmtp;
      if (previousEmail === undefined) delete process.env.EMAIL_CONCURRENCY;
      else process.env.EMAIL_CONCURRENCY = previousEmail;
    }
  });

  it("limits concurrency across overlapping deliverNotifications calls", async () => {
    const usersA = Array.from({ length: 4 }, (_, i) => who(`userA${i}`));
    const usersB = Array.from({ length: 4 }, (_, i) => who(`userB${i}`));
    findMany.mockImplementation(async ({ where }) => {
      const ids: string[] = where.id.in;
      return [...usersA, ...usersB].filter((u) => ids.includes(u.id));
    });

    let inFlight = 0;
    let peakInFlight = 0;
    send.mockImplementation(async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
    });

    const previousSmtp = process.env.SMTP_MAX_CONCURRENCY;
    const previousEmail = process.env.EMAIL_CONCURRENCY;
    process.env.SMTP_MAX_CONCURRENCY = String(DEFAULT_SMTP_CONCURRENCY);
    delete process.env.EMAIL_CONCURRENCY;

    try {
      await Promise.all([
        deliverNotifications({
          ...base,
          kind: "mentioned",
          recipientIds: usersA.map((u) => u.id),
          place: "comment",
        }),
        deliverNotifications({
          ...base,
          kind: "mentioned",
          recipientIds: usersB.map((u) => u.id),
          place: "comment",
        }),
      ]);

      expect(send).toHaveBeenCalledTimes(8);
      expect(peakInFlight).toBeLessThanOrEqual(DEFAULT_SMTP_CONCURRENCY);
    } finally {
      if (previousSmtp === undefined) delete process.env.SMTP_MAX_CONCURRENCY;
      else process.env.SMTP_MAX_CONCURRENCY = previousSmtp;
      if (previousEmail === undefined) delete process.env.EMAIL_CONCURRENCY;
      else process.env.EMAIL_CONCURRENCY = previousEmail;
    }
  });
});

describe("getSmtpConcurrency", () => {
  it("defaults to DEFAULT_SMTP_CONCURRENCY when env is unset", () => {
    delete process.env.SMTP_MAX_CONCURRENCY;
    delete process.env.EMAIL_CONCURRENCY;
    expect(getSmtpConcurrency()).toBe(DEFAULT_SMTP_CONCURRENCY);
  });

  it("reads SMTP_MAX_CONCURRENCY when valid", () => {
    process.env.SMTP_MAX_CONCURRENCY = "4";
    expect(getSmtpConcurrency()).toBe(4);
    delete process.env.SMTP_MAX_CONCURRENCY;
  });

  it("falls back to default on invalid or negative values", () => {
    process.env.SMTP_MAX_CONCURRENCY = "-1";
    expect(getSmtpConcurrency()).toBe(DEFAULT_SMTP_CONCURRENCY);
    delete process.env.SMTP_MAX_CONCURRENCY;
  });
});

describe("mapConcurrent", () => {
  it("preserves order and resolves all results", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapConcurrent(items, 2, async (x) => x * 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it("handles empty arrays", async () => {
    const results = await mapConcurrent([], 2, async (x) => x);
    expect(results).toEqual([]);
  });

  it("never executes more than the concurrency limit concurrently", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const items = Array.from({ length: 8 }, (_, i) => i);

    await mapConcurrent(items, 3, async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    });

    expect(peakInFlight).toBeLessThanOrEqual(3);
  });
});
