import { describe, expect, it, vi, beforeEach } from "vitest";

const publishWebEvent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/agent-api/web-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-api/web-events")>()),
  publishWebEvent,
}));

vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor: vi.fn(async () => "tenant-zedu"),
  defaultProjectIdFor: vi.fn(async () => "project-zedu"),
  tenantIdForUser: vi.fn(async () => "tenant-zedu"),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

const requireUser = vi.hoisted(() =>
  vi.fn(async () => ({ id: "reporter-1", name: "Ada", role: "user" })),
);
vi.mock("@/lib/auth-helpers", () => ({ requireUser }));

vi.mock("@/lib/tenant-access", () => ({
  currentTenantAccess: vi.fn(async () => ({
    tenantId: "tenant-zedu",
    tenantName: "Zedu",
    tenantSlug: "zedu",
    membershipRole: "member",
    admin: false,
  })),
}));

vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: vi.fn(),
  SESSION_EXPIRED_MESSAGE: "Session expired, sign in again",
}));

vi.mock("@/lib/notify", () => ({
  notifyLater: vi.fn(),
}));

const tx = vi.hoisted(() => ({
  bug: { update: vi.fn() },
  bugActivity: { create: vi.fn() },
}));

const findAuditEventMock = vi.hoisted(() =>
  vi.fn<() => Promise<{ id: string; payload: unknown } | null>>(async () => null),
);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bug: { findUnique: vi.fn() },
    agentAuditEvent: { findFirst: findAuditEventMock },
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  },
}));

import { prisma } from "@/lib/prisma";
import { editProofLinksAction } from "./issues";
import { TICKET_EDIT_ERRORS } from "@/lib/ticket-editing";

const findBugMock = vi.mocked(prisma.bug.findUnique) as unknown as ReturnType<typeof vi.fn>;

const ISSUE = "https://github.com/Zedu-Endor/issue-tracker/issues/737";
const PR = "https://github.com/Zedu-Endor/issue-tracker/pull/900";
const WRONG = "https://github.com/Zedu-Endor/issue-tracker/issues/7";

function existingBug(proofLinks: string[], overrides: Record<string, unknown> = {}) {
  return {
    id: "bug-1",
    proofLinks,
    reporterId: "reporter-1",
    isDeleted: false,
    ...overrides,
  };
}

function save(proofLinks: string) {
  const formData = new FormData();
  formData.set("proofLinks", proofLinks);
  return editProofLinksAction("bug-1", formData);
}

describe("editProofLinksAction (#737)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds proof links to an issue filed without any", async () => {
    findBugMock.mockResolvedValue(existingBug([]));

    const result = await save(`${ISSUE}\n${PR}`);

    expect(result).toEqual({ ok: true });
    expect(tx.bug.update).toHaveBeenCalledWith({
      where: { id: "bug-1" },
      data: expect.objectContaining({ proofLinks: [ISSUE, PR], pullRequestUrl: PR }),
    });
    expect(tx.bugActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bugId: "bug-1",
        actorId: "reporter-1",
        type: "edited",
        summary: "added 2 proof links",
        metadata: { fields: ["proofLinks"], added: [ISSUE, PR], removed: [] },
      }),
    });
    expect(publishWebEvent).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ bugId: "bug-1", type: "issue.updated" }),
    );
  });

  it("corrects a mistaken link", async () => {
    findBugMock.mockResolvedValue(existingBug([WRONG]));

    const result = await save(ISSUE);

    expect(result).toEqual({ ok: true });
    expect(tx.bug.update).toHaveBeenCalledWith({
      where: { id: "bug-1" },
      data: expect.objectContaining({ proofLinks: [ISSUE] }),
    });
    expect(tx.bugActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        summary: "added a proof link and removed a proof link",
      }),
    });
  });

  it("removes every link when the field is cleared", async () => {
    findBugMock.mockResolvedValue(existingBug([ISSUE, PR]));

    const result = await save("");

    expect(result).toEqual({ ok: true });
    expect(tx.bug.update).toHaveBeenCalledWith({
      where: { id: "bug-1" },
      data: expect.objectContaining({ proofLinks: [] }),
    });
  });

  it("rejects a link that is not on GitHub and saves nothing", async () => {
    findBugMock.mockResolvedValue(existingBug([]));

    const result = await save("https://example.com/not-github");

    expect(result.error).toBeTruthy();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects more than 20 links", async () => {
    findBugMock.mockResolvedValue(existingBug([]));
    const links = Array.from({ length: 21 }, (_, i) => `${ISSUE}?n=${i}`).join("\n");

    const result = await save(links);

    expect(result.error).toBeTruthy();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("writes nothing when the links did not change", async () => {
    findBugMock.mockResolvedValue(existingBug([ISSUE, PR]));

    const result = await save(`${ISSUE}\n${PR}\n`);

    expect(result).toEqual({ ok: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses someone who is not the reporter or an admin", async () => {
    findBugMock.mockResolvedValue(existingBug([], { reporterId: "someone-else" }));

    const result = await save(ISSUE);

    expect(result).toEqual({ error: TICKET_EDIT_ERRORS.unauthorized });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a deleted issue", async () => {
    findBugMock.mockResolvedValue(existingBug([], { isDeleted: true }));

    const result = await save(ISSUE);

    expect(result).toEqual({ error: TICKET_EDIT_ERRORS.notFound });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("unlinks pull request when proof links are cleared before acceptance", async () => {
    findBugMock.mockResolvedValue(existingBug([PR], { pullRequestUrl: PR }));

    const result = await save("");

    expect(result).toEqual({ ok: true });
    expect(tx.bug.update).toHaveBeenCalledWith({
      where: { id: "bug-1" },
      data: expect.objectContaining({ proofLinks: [], pullRequestUrl: null }),
    });
  });

  it("updates pull request when proof links are replaced before acceptance", async () => {
    const OTHER_PR = "https://github.com/Zedu-Endor/issue-tracker/pull/999";
    findBugMock.mockResolvedValue(existingBug([PR], { pullRequestUrl: PR }));

    const result = await save(OTHER_PR);

    expect(result).toEqual({ ok: true });
    expect(tx.bug.update).toHaveBeenCalledWith({
      where: { id: "bug-1" },
      data: expect.objectContaining({ proofLinks: [OTHER_PR], pullRequestUrl: OTHER_PR }),
    });
  });

  it("refuses to change pull request when fix has already been accepted", async () => {
    const OTHER_PR = "https://github.com/Zedu-Endor/issue-tracker/pull/999";
    findBugMock.mockResolvedValue(existingBug([PR], { pullRequestUrl: PR }));
    findAuditEventMock.mockResolvedValueOnce({
      id: "event-accepted",
      payload: { pullRequestUrl: PR },
    });

    const result = await save(OTHER_PR);

    expect(result).toEqual({
      error: expect.any(String),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

