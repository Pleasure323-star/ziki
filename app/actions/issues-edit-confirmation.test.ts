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

vi.mock("@/lib/auth-helpers", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "reporter-1", name: "Ada", role: "user" }),
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

vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: vi.fn(),
  SESSION_EXPIRED_MESSAGE: "Session expired, sign in again",
}));

vi.mock("@/lib/notify", () => ({
  notifyLater: vi.fn(),
}));

const isConfirmedMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-api/validation", () => ({
  isConfirmed: isConfirmedMock,
}));

const correctMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/points/correct", () => ({
  correct: correctMock,
}));

const db = vi.hoisted(() => {
  const tx = {
    bug: { update: vi.fn() },
    bugActivity: { create: vi.fn() },
    bugRevision: { create: vi.fn() },
    issueValidation: { deleteMany: vi.fn() },
    pointEntry: { findFirst: vi.fn(), update: vi.fn() },
    $queryRaw: vi.fn(async () => [{ title: "Original Title", description: "Original Description" }]),
  };
  return {
    tx,
    prisma: {
      bug: { findUnique: vi.fn() },
      user: { findMany: vi.fn() },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: db.prisma }));

import { editBugContentAction } from "./issues";

function existingBug(overrides: Record<string, unknown> = {}) {
  return {
    id: "bug-1",
    title: "Original Title",
    description: "Original Description",
    reporterId: "reporter-1",
    beneficiaryUserId: "reporter-1",
    tenantId: "tenant-zedu",
    isDeleted: false,
    ...overrides,
  };
}

function makeFormData(title: string, description: string) {
  const form = new FormData();
  form.set("title", title);
  form.set("description", description);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.prisma.bug.findUnique.mockResolvedValue(existingBug());
  db.tx.pointEntry.findFirst.mockResolvedValue({
    id: "entry-1",
    tenantId: "tenant-zedu",
    userId: "reporter-1",
    bugId: "bug-1",
    role: "reporter",
    points: 5,
  });
});

describe("editBugContentAction confirmation and validation invalidation (#713)", () => {
  it("invalidates confirmations, reverses reporter points, and clears validations on edit", async () => {
    isConfirmedMock.mockResolvedValue(true);

    const formData = makeFormData("Updated Title", "Updated Description with new reproduction steps");
    const result = await editBugContentAction("bug-1", formData);

    expect(result).toEqual({ ok: true });

    // Checked if confirmed
    expect(isConfirmedMock).toHaveBeenCalledWith("bug-1", db.tx);

    // Found reporter points entry
    expect(db.tx.pointEntry.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-zedu",
        sourceKey: "reporter:bug-1:reporter-1",
      },
      select: { id: true, tenantId: true, userId: true, bugId: true, role: true, points: true },
    });

    // Reversed reporter points via correct()
    expect(correctMock).toHaveBeenCalledWith(db.tx, {
      entry: expect.objectContaining({ id: "entry-1", points: 5, role: "reporter" }),
    });

    // Freed up the sourceKey
    expect(db.tx.pointEntry.update).toHaveBeenCalledWith({
      where: { id: "entry-1" },
      data: {
        sourceKey: "reporter:bug-1:reporter-1:invalidated:entry-1",
      },
    });

    // Deleted validations for this bug
    expect(db.tx.issueValidation.deleteMany).toHaveBeenCalledWith({
      where: { bugId: "bug-1" },
    });
  });

  it("sends an Open issue back to Requires confirmation, since its reviews are void (#requires-confirmation)", async () => {
    isConfirmedMock.mockResolvedValue(true);
    db.prisma.bug.findUnique.mockResolvedValue(existingBug({ status: "open" }));
    await editBugContentAction("bug-1", makeFormData("Updated Title", "Updated Description with new reproduction steps"));
    expect(db.tx.bug.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "requires_confirmation" }),
    }));

    vi.clearAllMocks();
    db.prisma.bug.findUnique.mockResolvedValue(existingBug({ status: "in_progress" }));
    await editBugContentAction("bug-1", makeFormData("Updated Title", "Updated Description with new reproduction steps"));
    expect(db.tx.bug.update.mock.calls[0][0].data).not.toHaveProperty("status");
  });

  it("deletes validations but writes no point correction when issue was not confirmed", async () => {
    isConfirmedMock.mockResolvedValue(false);

    const formData = makeFormData("Updated Title", "Updated Description with new reproduction steps");
    const result = await editBugContentAction("bug-1", formData);

    expect(result).toEqual({ ok: true });
    expect(isConfirmedMock).toHaveBeenCalledWith("bug-1", db.tx);
    expect(correctMock).not.toHaveBeenCalled();
    expect(db.tx.pointEntry.findFirst).not.toHaveBeenCalled();
    expect(db.tx.issueValidation.deleteMany).toHaveBeenCalledWith({
      where: { bugId: "bug-1" },
    });
  });

  it("does nothing when title and description are unchanged", async () => {
    const formData = makeFormData("Original Title", "Original Description");
    const result = await editBugContentAction("bug-1", formData);

    expect(result).toEqual({ ok: true });
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
    expect(db.tx.issueValidation.deleteMany).not.toHaveBeenCalled();
  });
});
