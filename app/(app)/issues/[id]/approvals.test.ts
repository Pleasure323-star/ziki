// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor: vi.fn(async () => "tenant-zedu"),
  defaultProjectIdFor: vi.fn(async () => "project-zedu"),
  tenantIdForUser: vi.fn(async () => "tenant-zedu"),
}));

vi.mock("@/lib/tenant-viewer", () => ({
  viewerBugScope: vi.fn(async () => ({ tenantId: "tenant-zedu" })),
}));

vi.mock("@/lib/tenant-access", () => ({
  currentTenantAccess: vi.fn(async () => ({
    tenantId: "tenant-zedu",
    tenantName: "Zedu",
    tenantSlug: "zedu",
    membershipRole: "admin" as const,
    admin: true,
  })),
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  notFound: vi.fn(),
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/roles", () => ({
  isAdmin: vi.fn().mockReturnValue(true),
  isSuperAdmin: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/agents/membership", () => ({
  isTenantAdminRole: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/ticket-deletion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ticket-deletion")>()),
  canDeleteTicket: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/ticket-editing", () => ({
  canEditTicket: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/ticket-assignment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ticket-assignment")>()),
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

vi.mock("@/lib/comment-window", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comment-window")>()),
  loadCommentWindow: vi.fn().mockResolvedValue({
    comments: [],
    threads: [],
    totalThreads: 0,
    shownThreads: 0,
    hiddenThreads: 0,
    visibleCount: 0,
  }),
}));

vi.mock("@/lib/platforms", () => ({
  getActivePlatforms: vi.fn().mockResolvedValue([]),
}));

const mockDb = vi.hoisted(() => ({
  membership: { findUnique: vi.fn().mockResolvedValue({ role: "admin", userId: "user-123" }), findMany: vi.fn().mockResolvedValue([]) },
  bug: { findUnique: vi.fn(), findFirst: vi.fn(async () => ({ id: "bug-1", number: 1 })) },
  redesignProposal: { findMany: vi.fn().mockResolvedValue([]) },
  issueBid: { findMany: vi.fn().mockResolvedValue([]) },
  issueApproval: { findFirst: vi.fn() },
  agentQuestion: { findMany: vi.fn().mockResolvedValue([]) },
  user: { findMany: vi.fn().mockResolvedValue([]) },
  category: { findMany: vi.fn().mockResolvedValue([]) },
  bugActivity: {
    count: vi.fn().mockResolvedValue(0),
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
  },
  attachment: { findMany: vi.fn().mockResolvedValue([]) },
  bugRevision: { findFirst: vi.fn().mockResolvedValue(null) },
  milestone: { findMany: vi.fn().mockResolvedValue([]) },
  issueConfirmation: { findMany: vi.fn().mockResolvedValue([]) },
  issueClaim: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
  testVerdict: { findMany: vi.fn().mockResolvedValue([]) },
  agentAuditEvent: { findMany: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockDb }));

import { resolveSessionUserId } from "@/lib/session-user";
import { requireUser } from "@/lib/auth-helpers";
import { isTenantAdminRole } from "@/lib/agents/membership";
import BugDetailPage from "./page";

describe("Issue page human approval banner (#598)", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(resolveSessionUserId).mockResolvedValue({ userId: "user-123" });
    vi.mocked(requireUser).mockResolvedValue({
      id: "user-123",
      role: "admin",
    } as never);
    mockDb.bug.findUnique.mockResolvedValue({
      id: "bug-1",
      number: 42,
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
      isDeleted: false,
    });
  });

  it("shows 'Human approval required' banner with Approve/Reject for tenant admins", async () => {
    vi.mocked(isTenantAdminRole).mockReturnValue(true);
    mockDb.issueApproval.findFirst.mockResolvedValue({
      id: "appr-1",
      bugId: "bug-1",
      stage: "before_merge",
      status: "pending",
      rule: {
        issueType: { name: "Design" },
        fileGlob: null,
      },
    });

    const page = await BugDetailPage({
      params: Promise.resolve({ id: "1" }),
    });

    render(page);
    expect(screen.getByText("Human approval required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("shows banner without action buttons for non-admins", async () => {
    vi.mocked(isTenantAdminRole).mockReturnValue(false);
    mockDb.issueApproval.findFirst.mockResolvedValue({
      id: "appr-1",
      bugId: "bug-1",
      stage: "before_offer",
      status: "pending",
      rule: null,
    });

    const page = await BugDetailPage({
      params: Promise.resolve({ id: "1" }),
    });

    render(page);
    expect(screen.getByText("Human approval required")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByText(/Waiting for workspace owner or admin decision/i)).toBeInTheDocument();
  });

  it("does not render banner when no approval is pending", async () => {
    mockDb.issueApproval.findFirst.mockResolvedValue(null);

    const page = await BugDetailPage({
      params: Promise.resolve({ id: "1" }),
    });

    render(page);
    expect(screen.queryByText("Human approval required")).not.toBeInTheDocument();
  });
});
