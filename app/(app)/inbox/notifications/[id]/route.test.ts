import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: vi.fn() }));
vi.mock("@/lib/cache-tags", () => ({
  expireTag: vi.fn(),
  TAGS: { unread: (id: string) => `unread:${id}` },
}));
vi.mock("@/lib/tenants", () => ({
  memberTenantById: vi.fn(),
  readActiveTenantCookie: vi.fn(),
  setActiveTenantCookie: vi.fn(),
}));
vi.mock("@/lib/project-context", () => ({ setActiveProjectCookie: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { resolveSessionUserId } from "@/lib/session-user";
import { expireTag } from "@/lib/cache-tags";
import { prisma } from "@/lib/prisma";
import { memberTenantById, readActiveTenantCookie, setActiveTenantCookie } from "@/lib/tenants";
import { setActiveProjectCookie } from "@/lib/project-context";
import { GET } from "./route";

const sessionUser = vi.mocked(resolveSessionUserId) as unknown as ReturnType<typeof vi.fn>;
const findUnique = vi.mocked(prisma.notification.findUnique) as unknown as ReturnType<typeof vi.fn>;
const update = vi.mocked(prisma.notification.update) as unknown as ReturnType<typeof vi.fn>;
const expireTagMock = vi.mocked(expireTag) as unknown as ReturnType<typeof vi.fn>;
const memberTenantMock = vi.mocked(memberTenantById) as unknown as ReturnType<typeof vi.fn>;
const activeTenantMock = vi.mocked(readActiveTenantCookie) as unknown as ReturnType<typeof vi.fn>;
const setTenantMock = vi.mocked(setActiveTenantCookie) as unknown as ReturnType<typeof vi.fn>;
const setProjectMock = vi.mocked(setActiveProjectCookie) as unknown as ReturnType<typeof vi.fn>;

function makeRequest(id: string, origin = "http://localhost:3000") {
  return GET(new NextRequest(`${origin}/notifications/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe("GET /notifications/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionUser.mockResolvedValue({ userId: "u1" });
    memberTenantMock.mockResolvedValue({ id: "tenant-2" });
    activeTenantMock.mockResolvedValue("tenant-2");
  });

  it("redirects to /login if user is not signed in", async () => {
    sessionUser.mockResolvedValue({ error: "Unauthorized" });
    const res = await makeRequest("notif-1");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/login");
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("redirects to /notifications if notification does not exist", async () => {
    findUnique.mockResolvedValue(null);
    const res = await makeRequest("missing-notif");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/notifications");
    expect(update).not.toHaveBeenCalled();
  });

  it("redirects to /notifications if notification belongs to someone else", async () => {
    findUnique.mockResolvedValue({
      userId: "u2",
      url: "/issues/bug-1",
      readAt: null,
    });
    const res = await makeRequest("notif-other");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/notifications");
    expect(update).not.toHaveBeenCalled();
  });

  it("marks unread notification as read, expires tag, and redirects to target URL", async () => {
    findUnique.mockResolvedValue({
      userId: "u1",
      url: "/issues/bug-42#comment-9",
      readAt: null,
    });
    const res = await makeRequest("notif-1");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/issues/bug-42#comment-9");
    expect(update).toHaveBeenCalledWith({
      where: { id: "notif-1" },
      data: { readAt: expect.any(Date) },
    });
    expect(expireTagMock).toHaveBeenCalledWith("unread:u1");
  });

  it("switches to the notification's tenant before opening its issue", async () => {
    findUnique.mockResolvedValue({
      userId: "u1",
      tenantId: "tenant-2",
      url: "/issues/bug-42",
      readAt: null,
    });
    activeTenantMock.mockResolvedValue("tenant-1");
    const res = await makeRequest("notif-tenant-2");
    expect(res.headers.get("location")).toBe("/issues/bug-42");
    expect(memberTenantMock).toHaveBeenCalledWith(expect.anything(), "u1", "tenant-2");
    expect(setTenantMock).toHaveBeenCalledWith("tenant-2");
    expect(setProjectMock).toHaveBeenCalledWith("");
  });

  it("does not open a notification for a workspace the user left", async () => {
    findUnique.mockResolvedValue({ userId: "u1", tenantId: "tenant-2", url: "/issues/bug-42", readAt: null });
    memberTenantMock.mockResolvedValue(null);
    const res = await makeRequest("notif-left-tenant");
    expect(res.headers.get("location")).toBe("/notifications");
    expect(update).not.toHaveBeenCalled();
  });

  it("never sends the browser to the container's bind address behind the proxy (#416)", async () => {
    findUnique.mockResolvedValue({ userId: "u1", url: "/issues/bug-42", readAt: null });
    const res = await makeRequest("notif-1", "https://0.0.0.0:3000");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/issues/bug-42");
  });

  it("keeps a stored off-site URL on the site", async () => {
    findUnique.mockResolvedValue({ userId: "u1", url: "//evil.example/phish", readAt: null });
    const res = await makeRequest("notif-1");
    expect(res.headers.get("location")).toBe("/issues");
  });

  it("does not re-update if notification was already read", async () => {
    findUnique.mockResolvedValue({
      userId: "u1",
      url: "/issues/bug-42",
      readAt: new Date("2026-01-01T00:00:00Z"),
    });
    const res = await makeRequest("notif-1");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/issues/bug-42");
    expect(update).not.toHaveBeenCalled();
    expect(expireTagMock).not.toHaveBeenCalled();
  });
});
