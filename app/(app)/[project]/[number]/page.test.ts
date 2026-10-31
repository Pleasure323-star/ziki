import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// #425: run as a member of the Zedu tenant.
vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor: vi.fn(async () => "tenant-zedu"),
  defaultProjectIdFor: vi.fn(async () => "project-zedu"),
  tenantIdForUser: vi.fn(async () => "tenant-zedu"),
}));
vi.mock("@/lib/tenant-viewer", () => ({
  viewerBugScope: vi.fn(async () => ({ tenantId: "tenant-zedu" })),
}));

const tenantAccess = vi.hoisted(() => ({
  currentTenantAccess: vi.fn(async (_id: string, role: string) => ({
    tenantId: "tenant-zedu",
    tenantName: "Zedu",
    tenantSlug: "zedu",
    membershipRole: "member" as "owner" | "admin" | "member",
    admin: role === "super_admin",
  })),
}));
vi.mock("@/lib/tenant-access", () => tenantAccess);

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  redirect: vi.fn(),
  permanentRedirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));

vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: vi.fn(),
}));

// #project-urls: /<project-slug>/<number> is looked up in lib/project-issue.ts.
const foundIssue = { kind: "found" as const, issue: { id: "bug-1", number: 1, projectSlug: "zedu", isDeleted: false } };
vi.mock("@/lib/project-issue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-issue")>()),
  findProjectIssue: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/roles", () => ({
  isAdmin: vi.fn((role) => role === "admin" || role === "super_admin"),
  isSuperAdmin: vi.fn((role) => role === "super_admin"),
}));

vi.mock("@/lib/ticket-deletion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ticket-deletion")>()),
  canDeleteTicket: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/ticket-editing", () => ({
  canEditTicket: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/ticket-assignment", () => ({
  canAssignTicket: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/voter-summaries", () => ({
  fetchVoterSummary: vi.fn().mockResolvedValue({
    likes: { count: 0, preview: [] },
    dislikes: { count: 0, preview: [] },
  }),
  createEmptyVoterSummary: vi.fn().mockReturnValue({
    likes: { count: 0, preview: [] },
    dislikes: { count: 0, preview: [] },
  }),
}));

vi.mock("@/lib/lookups", () => ({
  getActiveIssueTypesCached: vi.fn().mockResolvedValue([]),
  getActivePlatforms: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/comment-window", () => ({
  COMMENT_PARAM: "comment",
  COMMENT_THREADS_PER_PAGE: 10,
  earlierThreadsHref: vi.fn().mockReturnValue("#"),
  loadCommentWindow: vi.fn().mockResolvedValue({
    comments: [],
    threads: [],
    totalThreads: 0,
    shownThreads: 0,
    hiddenThreads: 0,
    visibleCount: 0,
  }),
  parseCommentTarget: vi.fn(),
  parseThreadWindow: vi.fn().mockReturnValue(10),
}));

vi.mock("@/lib/platforms", () => ({
  getActivePlatforms: vi.fn().mockResolvedValue([]),
}));

// The close-suggestions panel reads its own rows (#close-superseded); these tests count the issue queries only.
vi.mock("@/lib/agent-api/close-suggestions", () => ({
  closeSuggestionsFor: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membership: { findUnique: vi.fn().mockResolvedValue({ role: "member", userId: "user-123" }), findMany: vi.fn().mockResolvedValue([]) },
    bug: { findUnique: vi.fn(), findFirst: vi.fn() },
    redesignProposal: { findMany: vi.fn().mockResolvedValue([]) },
    issueBid: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn() },
    category: { findMany: vi.fn().mockResolvedValue([]) },
    bugActivity: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    attachment: { findMany: vi.fn().mockResolvedValue([]) },
    bugRevision: { findFirst: vi.fn().mockResolvedValue(null) },
    milestone: { findMany: vi.fn().mockResolvedValue([]) },
    goal: { findMany: vi.fn().mockResolvedValue([]) },
    issueConfirmation: { findMany: vi.fn().mockResolvedValue([]) },
    issueClaim: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    testVerdict: { findMany: vi.fn().mockResolvedValue([]) },
    agentAuditEvent: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { resolveSessionUserId } from "@/lib/session-user";
import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { parseCommentTarget } from "@/lib/comment-window";
import { findProjectIssue } from "@/lib/project-issue";
import BugDetailPage from "./page";

const mockResolveSessionUserId = vi.mocked(resolveSessionUserId);
const mockRequireUser = vi.mocked(requireUser);
const mockUserFindMany = vi.mocked(prisma.user.findMany);
const mockBugFindUnique = vi.mocked(prisma.bug.findUnique);
const mockFindProjectIssue = vi.mocked(findProjectIssue);

describe("BugDetailPage conditional user query (#349)", () => {
  describe("runtime execution", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockResolveSessionUserId.mockResolvedValue({ userId: "user-123" });
      mockFindProjectIssue.mockResolvedValue(foundIssue);
      mockBugFindUnique.mockResolvedValue({
        id: "bug-1",
        number: 42,
        tenantId: "tenant-zedu",
        title: "Test Bug",
        description: "Test Description",
        status: "open",
        voteCount: 0,
        proofLinks: [],
        reporterId: "reporter-1",
        assigneeId: null,
        type: null,
        reporter: { name: "Reporter", email: "rep@zedu.dev", role: "user" },
        assignee: null,
        category: null,
        milestone: null,
        duplicateOf: null,
        duplicates: [],
        _count: { duplicates: 0 },
        comments: [],
        activities: [],
        votes: [],
        project: { slug: "zedu" },
        isDeleted: false,
      } as unknown as Awaited<ReturnType<typeof prisma.bug.findUnique>>);
    });

    it("does not query database users when viewer is a non-admin user", async () => {
      mockRequireUser.mockResolvedValue({
        id: "user-123",
        role: "user",
      } as unknown as Awaited<ReturnType<typeof requireUser>>);

      await BugDetailPage({
        params: Promise.resolve({ project: "zedu", number: "1" }),
      });

      expect(mockUserFindMany).not.toHaveBeenCalled();
    });

    it("does not query database users when a site admin is only a member", async () => {
      mockRequireUser.mockResolvedValue({
        id: "admin-123",
        role: "admin",
      } as unknown as Awaited<ReturnType<typeof requireUser>>);

      await BugDetailPage({
        params: Promise.resolve({ project: "zedu", number: "1" }),
      });

      expect(mockUserFindMany).not.toHaveBeenCalled();
    });

    it("queries database users when the viewer administers this organization", async () => {
      tenantAccess.currentTenantAccess.mockResolvedValueOnce({
        tenantId: "tenant-zedu",
        tenantName: "Zedu",
        tenantSlug: "zedu",
        membershipRole: "owner",
        admin: true,
      });
      mockRequireUser.mockResolvedValue({
        id: "admin-123",
        role: "user",
      } as unknown as Awaited<ReturnType<typeof requireUser>>);
      mockUserFindMany.mockResolvedValue([
        { id: "u-1", name: "Alice", role: "admin", image: null },
      ] as unknown as Awaited<ReturnType<typeof prisma.user.findMany>>);

      await BugDetailPage({
        params: Promise.resolve({ project: "zedu", number: "1" }),
      });

      expect(mockUserFindMany).toHaveBeenCalledTimes(1);
      // #502: only the issue's tenant can be mentioned or assigned.
      expect(mockUserFindMany).toHaveBeenCalledWith({
        where: { memberships: { some: { tenantId: "tenant-zedu" } } },
        orderBy: { name: "asc" },
        select: { id: true, name: true, role: true, image: true },
      });
    });

    it("queries database users when viewer is a super admin", async () => {
      mockRequireUser.mockResolvedValue({
        id: "super-123",
        role: "super_admin",
      } as unknown as Awaited<ReturnType<typeof requireUser>>);
      mockUserFindMany.mockResolvedValue([
        { id: "u-1", name: "Alice", role: "admin", image: null },
      ] as unknown as Awaited<ReturnType<typeof prisma.user.findMany>>);

      await BugDetailPage({
        params: Promise.resolve({ project: "zedu", number: "1" }),
      });

      expect(mockUserFindMany).toHaveBeenCalledTimes(1);
      // #502: only the issue's tenant can be mentioned or assigned.
      expect(mockUserFindMany).toHaveBeenCalledWith({
        where: { memberships: { some: { tenantId: "tenant-zedu" } } },
        orderBy: { name: "asc" },
        select: { id: true, name: true, role: true, image: true },
      });
    });

    it("observes database query counts and asserts non-triage viewer does not execute full user directory query (#349)", async () => {
      mockRequireUser.mockResolvedValue({
        id: "user-123",
        role: "user",
      } as unknown as Awaited<ReturnType<typeof requireUser>>);

      const countQueries = () =>
        mockBugFindUnique.mock.calls.length +
        mockUserFindMany.mock.calls.length +
        vi.mocked(prisma.attachment.findMany).mock.calls.length;

      const before = countQueries();
      await BugDetailPage({
        params: Promise.resolve({ project: "zedu", number: "1" }),
      });
      const executed = countQueries() - before;

      // Non-triage viewer must execute queries for bug and attachments, but 0 user directory queries
      expect(executed).toBeGreaterThan(0);
      expect(mockUserFindMany).toHaveBeenCalledTimes(0);
    });

    it("falls back to querying without milestone when Bug.milestoneId column does not exist (#289)", async () => {
      mockRequireUser.mockResolvedValue({
        id: "user-123",
        role: "user",
      } as unknown as Awaited<ReturnType<typeof requireUser>>);

      mockBugFindUnique
        .mockRejectedValueOnce(new Error("The column Bug.milestoneId does not exist in the current database."))
        .mockResolvedValueOnce({
          id: "bug-1",
          number: 1,
          title: "Test bug",
          status: "open",
          description: "description",
          createdAt: new Date(),
          updatedAt: new Date(),
          reporterId: "user-123",
          assigneeId: null,
          categoryId: null,
          typeId: null,
          isDeleted: false,
          project: { slug: "zedu" },
          type: null,
          reporter: { name: "Test User", email: "test@example.com", role: "user", image: null },
          assignee: null,
          category: null,
          votes: [],
          duplicateOf: null,
          duplicates: [],
          _count: { duplicates: 0 },
        } as unknown as Awaited<ReturnType<typeof prisma.bug.findUnique>>);

      const element = await BugDetailPage({
        params: Promise.resolve({ project: "zedu", number: "1" }),
      });

      expect(element).toBeDefined();
      expect(mockBugFindUnique).toHaveBeenCalledTimes(2);
      expect(mockBugFindUnique).toHaveBeenLastCalledWith(
        expect.objectContaining({
          include: expect.not.objectContaining({
            milestone: expect.anything(),
          }),
        }),
      );
    });

    it("shows a reference instead of the database error when the issue can't load", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mockRequireUser.mockResolvedValue({
        id: "user-123",
        role: "user",
      } as unknown as Awaited<ReturnType<typeof requireUser>>);
      const dbError = new Error('relation "Bug" violates constraint "Bug_tenantId_fkey" on column secret_col');
      mockBugFindUnique.mockRejectedValueOnce(dbError);

      const element = await BugDetailPage({ params: Promise.resolve({ project: "zedu", number: "1" }) });
      const html = renderToStaticMarkup(element as ReactElement);

      expect(html).toMatch(/could not be loaded/i);
      expect(html).not.toContain("Bug_tenantId_fkey");
      expect(html).not.toContain("secret_col");
      // The full error is logged, under the reference the page shows.
      const reference = html.match(/<code[^>]*>([0-9a-f]{8})<\/code>/)?.[1];
      expect(reference).toBeDefined();
      expect(consoleError).toHaveBeenCalledWith(`[issue] detail query failed (ref ${reference})`, dbError);
      consoleError.mockRestore();
    });

    describe("project issue addresses (#project-urls)", () => {
      beforeEach(() => {
        mockRequireUser.mockResolvedValue({ id: "user-123", role: "user" } as unknown as Awaited<ReturnType<typeof requireUser>>);
      });

      it("loads the issue by its number inside the project the URL names", async () => {
        await BugDetailPage({ params: Promise.resolve({ project: "zedu", number: "1" }) });
        expect(mockFindProjectIssue).toHaveBeenCalledWith("zedu", 1);
        expect(mockBugFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "bug-1" }) }));
        expect(vi.mocked(notFound)).not.toHaveBeenCalled();
      });

      it("permanently redirects a number that lives in another project there, keeping the query and the comment anchor", async () => {
        mockFindProjectIssue.mockResolvedValueOnce({
          kind: "moved",
          issue: { id: "bug-1", number: 1, projectSlug: "ziki", isDeleted: false },
        });
        vi.mocked(parseCommentTarget).mockReturnValueOnce("c9");
        await expect(
          BugDetailPage({
            params: Promise.resolve({ project: "zedu", number: "1" }),
            searchParams: Promise.resolve({ comment: "c9" }),
          }),
        ).rejects.toThrow(/^REDIRECT \/ziki\/1\?comment=c9#comment-c9$/);
        expect(mockBugFindUnique).not.toHaveBeenCalled();
      });

      it("redirects without a trailing ? or anchor when there is no query", async () => {
        mockFindProjectIssue.mockResolvedValueOnce({
          kind: "moved",
          issue: { id: "bug-1", number: 1, projectSlug: "ziki", isDeleted: false },
        });
        await expect(
          BugDetailPage({ params: Promise.resolve({ project: "zedu", number: "1" }) }),
        ).rejects.toThrow(/^REDIRECT \/ziki\/1$/);
      });

      it("is a 404 when the second segment is not an issue number", async () => {
        vi.mocked(notFound).mockImplementationOnce(() => {
          throw new Error("NOT_FOUND");
        });
        await expect(
          BugDetailPage({ params: Promise.resolve({ project: "zedu", number: "ZE-1" }) }),
        ).rejects.toThrow("NOT_FOUND");
        expect(mockFindProjectIssue).not.toHaveBeenCalled();
      });

      it("finds nothing for a number the viewer's organisations do not have", async () => {
        mockFindProjectIssue.mockResolvedValueOnce(null);
        vi.mocked(notFound).mockImplementationOnce(() => {
          throw new Error("NOT_FOUND");
        });
        await expect(
          BugDetailPage({ params: Promise.resolve({ project: "zedu", number: "999" }) }),
        ).rejects.toThrow("NOT_FOUND");
        expect(mockBugFindUnique).not.toHaveBeenCalled();
      });
    });
  });
});

