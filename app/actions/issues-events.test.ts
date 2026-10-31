import { beforeEach, describe, expect, it, vi } from "vitest";

const publish = vi.hoisted(() => vi.fn(async () => ({ id: "event-1" })));
vi.mock("@/lib/agent-api/events", () => ({ publish }));

vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor: vi.fn(async () => "tenant-zedu"),
  defaultProjectIdFor: vi.fn(async () => "project-zedu"),
  tenantIdForUser: vi.fn(async () => "tenant-zedu"),
}));

const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/notify", () => ({ notifyLater: vi.fn() }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "user-1", name: "Alice", role: "member" }),
}));

const prisma = vi.hoisted(() => ({
  idea: { create: vi.fn() },
  bug: { create: vi.fn() },
  user: { findUnique: vi.fn(), findMany: vi.fn() },
  category: { findFirst: vi.fn() },
  issueType: { findUnique: vi.fn() },
  attachment: { updateMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma }));

import { createBugAction } from "./issues";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe("filing a report from the web app (#534, #idea-table)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.idea.create.mockResolvedValue({ id: "idea-123", number: 12 });
    prisma.user.findMany.mockResolvedValue([]);
    prisma.attachment.updateMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation(async (run: (tx: unknown) => unknown) => run(prisma));
  });

  it("files an idea, not an issue, and opens the idea's page", async () => {
    await createBugAction(form({ title: "Something broke in production", description: "Here are the details of the problem that happened." }));
    expect(prisma.idea.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenantId: "tenant-zedu",
        projectId: "project-zedu",
        reporterId: "user-1",
        beneficiaryUserId: "user-1",
        title: "Something broke in production",
      }),
    }));
    expect(prisma.bug.create).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/ideas/12");
  });

  it("publishes idea.created exactly once with the complete payload", async () => {
    await createBugAction(form({ title: "Vulnerability found in auth endpoint", description: "Detailed description of the vulnerability report.", isReport: "true" }));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(prisma, {
      tenantId: "tenant-zedu",
      type: "idea.created",
      projectId: "project-zedu",
      payload: {
        ideaId: "idea-123",
        ideaNumber: 12,
        projectId: "project-zedu",
        reporterId: "user-1",
        beneficiaryUserId: "user-1",
        isReport: true,
        actor: { kind: "user", id: "user-1", name: "Alice" },
      },
    });
  });

  it("links the report's uploads to the idea", async () => {
    const data = form({ title: "Screenshot attached here", description: "See the attached screenshot for the problem." });
    data.set("attachmentIds", "attachment01");
    await createBugAction(data);
    expect(prisma.attachment.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["attachment01"] }, uploaderId: "user-1", bugId: null, ideaId: null, commentId: null, confirmationId: null },
      data: { ideaId: "idea-123" },
    });
  });
});
