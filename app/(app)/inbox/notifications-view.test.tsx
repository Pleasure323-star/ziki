import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  currentTenantIdFor: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  membershipCount: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/tenant-context", () => ({
  currentTenantIdFor: mocks.currentTenantIdFor,
  notificationInTenant: (tenantId: string | null, allWorkspaces = false) => allWorkspaces
    ? {}
    : tenantId
      ? { OR: [{ tenantId: null }, { tenantId }] }
      : { tenantId: null },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: { findMany: mocks.findMany, count: mocks.count },
    membership: { count: mocks.membershipCount },
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("@/components/local-time", () => ({ LocalTime: () => <time>now</time> }));
vi.mock("@/components/mark-all-read-button", () => ({
  MarkAllReadButton: ({ allWorkspaces }: { allWorkspaces: boolean }) => <button>{allWorkspaces ? "all" : "active"}</button>,
}));

import { NotificationsView as NotificationsPage } from "./notifications-view";

describe("NotificationsPage (#520)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
    mocks.currentTenantIdFor.mockResolvedValue("tenant-1");
    mocks.findMany.mockResolvedValue([
      { id: "n1", title: "Issue updated", tenant: { name: "Acme" }, readAt: null, createdAt: new Date() },
    ]);
    mocks.count.mockResolvedValue(1);
    mocks.membershipCount.mockResolvedValue(2);
  });

  it("shows tenant labels and an all-workspaces view", async () => {
    const page = await NotificationsPage({ searchParams: Promise.resolve({ scope: "all" }) });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Acme");
    expect(html).toContain("inbox?scope=all");
    expect(mocks.findMany.mock.calls[0]?.[0].where).toEqual({ userId: "user-1" });
  });

  it("filters the default view to the active workspace and personal notifications", async () => {
    await NotificationsPage({});

    expect(mocks.findMany.mock.calls[0]?.[0].where).toEqual({
      userId: "user-1",
      OR: [{ tenantId: null }, { tenantId: "tenant-1" }],
    });
  });

  it("pages past the latest 50 and keeps the workspace scope (#569)", async () => {
    mocks.count.mockResolvedValue(120);

    const page = await NotificationsPage({ searchParams: Promise.resolve({ scope: "all", page: "2" }) });
    const html = renderToStaticMarkup(page);

    expect(mocks.findMany.mock.calls[0]?.[0]).toMatchObject({ skip: 50, take: 50 });
    expect(html).toContain("Previous");
    expect(html).toContain("inbox?scope=all&amp;page=3");
  });

  it("clamps a page past the end to the last page instead of showing an empty list", async () => {
    mocks.count.mockResolvedValue(60);

    await NotificationsPage({ searchParams: Promise.resolve({ page: "99" }) });

    expect(mocks.findMany.mock.calls[0]?.[0]).toMatchObject({ skip: 50, take: 50 });
  });
});
