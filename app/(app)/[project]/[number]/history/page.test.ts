import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor: vi.fn(async () => "tenant-zedu"),
}));
vi.mock("@/lib/tenant-access", () => ({
  currentTenantAccess: vi.fn(async () => ({ tenantId: "tenant-zedu", membershipRole: "member", admin: false })),
}));
vi.mock("@/lib/auth-helpers", () => ({
  requireUser: vi.fn(async () => ({ id: "user-123", role: "user" })),
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  permanentRedirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));
vi.mock("@/lib/tenant-viewer", () => ({
  viewerBugScope: vi.fn(async () => ({ tenantId: "tenant-zedu" })),
}));
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: vi.fn(async () => ({ userId: "user-123" })),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { bug: { findUnique: vi.fn(), findFirst: vi.fn() } },
}));
// #project-urls: /<project-slug>/<number>/history is looked up in lib/project-issue.ts.
vi.mock("@/lib/project-issue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-issue")>()),
  findProjectIssue: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { findProjectIssue } from "@/lib/project-issue";
import IssueHistoryPage from "./page";

const issue = { id: "bug-7", number: 7, projectSlug: "zedu", isDeleted: false };

describe("issue history at its project address (#project-urls)", () => {
  beforeEach(() => {
    vi.mocked(prisma.bug.findUnique).mockReset();
    vi.mocked(findProjectIssue).mockReset();
  });

  it("reads the history of the issue numbered in the project the URL names", async () => {
    vi.mocked(findProjectIssue).mockResolvedValueOnce({ kind: "found", issue });
    vi.mocked(prisma.bug.findUnique).mockResolvedValueOnce({
      id: "bug-7",
      number: 7,
      project: { slug: "zedu" },
      title: "Title",
      description: "Body",
      createdAt: new Date("2026-10-01T00:00:00Z"),
      isDeleted: false,
      reporter: { name: "Reporter" },
      revisions: [],
    } as never);
    const page = await IssueHistoryPage({ params: Promise.resolve({ project: "zedu", number: "7" }) });
    expect(page).toBeDefined();
    expect(findProjectIssue).toHaveBeenCalledWith("zedu", 7);
    expect(prisma.bug.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "bug-7" } }));
  });

  it("permanently redirects a number that lives in another project to that project's history", async () => {
    vi.mocked(findProjectIssue).mockResolvedValueOnce({ kind: "moved", issue: { ...issue, projectSlug: "ziki" } });
    await expect(
      IssueHistoryPage({ params: Promise.resolve({ project: "zedu", number: "7" }) }),
    ).rejects.toThrow(/^REDIRECT \/ziki\/7\/history$/);
    expect(prisma.bug.findUnique).not.toHaveBeenCalled();
  });

  it("is a 404 for a segment that is not an issue number, without a lookup", async () => {
    await expect(
      IssueHistoryPage({ params: Promise.resolve({ project: "zedu", number: "cmlegacy0001" }) }),
    ).rejects.toThrow("NOT_FOUND");
    expect(findProjectIssue).not.toHaveBeenCalled();
  });

  it("is a 404 when the issue is in another of the viewer's organisations", async () => {
    vi.mocked(findProjectIssue).mockResolvedValueOnce({ kind: "elsewhere", issueId: "bug-other" });
    await expect(
      IssueHistoryPage({ params: Promise.resolve({ project: "zedu", number: "7" }) }),
    ).rejects.toThrow("NOT_FOUND");
  });
});
