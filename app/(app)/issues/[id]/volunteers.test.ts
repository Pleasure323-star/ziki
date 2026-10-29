// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";

// Run as a member of the Zedu tenant
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
    membershipRole: "member" as const,
    admin: false,
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
  isAdmin: vi.fn().mockReturnValue(false),
  isSuperAdmin: vi.fn().mockReturnValue(false),
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
  membership: { findUnique: vi.fn().mockResolvedValue({ role: "member", userId: "user-123" }), findMany: vi.fn().mockResolvedValue([]) },
  bug: { findUnique: vi.fn(), findFirst: vi.fn(async () => ({ id: "bug-1", number: 1 })) },
  redesignProposal: { findMany: vi.fn().mockResolvedValue([]) },
  issueBid: { findMany: vi.fn().mockResolvedValue([]) },
  issueInterest: { count: vi.fn() },
  agentQuestion: { findMany: vi.fn().mockResolvedValue([]) },
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
  issueConfirmation: { findMany: vi.fn().mockResolvedValue([]) },
  issueClaim: { findMany: vi.fn().mockResolvedValue([]) },
  testVerdict: { findMany: vi.fn().mockResolvedValue([]) },
  agentAuditEvent: { findMany: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockDb }));

import { resolveSessionUserId } from "@/lib/session-user";
import { requireUser } from "@/lib/auth-helpers";
import BugDetailPage from "./page";

describe("Issue page volunteer count display (#589)", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(resolveSessionUserId).mockResolvedValue({ userId: "user-123" });
    vi.mocked(requireUser).mockResolvedValue({
      id: "user-123",
      role: "user",
    } as never);
    mockDb.bug.findUnique.mockResolvedValue({
      id: "bug-1",
      number: 42,
      title: "Test Bug",
      description: "Test Description",
      status: "open",
      severity: "medium",
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

  it("shows '3 agents volunteered' when 3 agents registered interest", async () => {
    mockDb.issueInterest.count.mockResolvedValue(3);

    const page = await BugDetailPage({
      params: Promise.resolve({ id: "1" }),
    });

    render(page);
    expect(screen.getByText("3 agents volunteered")).toBeInTheDocument();
  });

  it("shows '1 agent volunteered' when 1 agent registered interest", async () => {
    mockDb.issueInterest.count.mockResolvedValue(1);

    const page = await BugDetailPage({
      params: Promise.resolve({ id: "1" }),
    });

    render(page);
    expect(screen.getByText("1 agent volunteered")).toBeInTheDocument();
  });

  it("does not render volunteer badge when 0 agents volunteered", async () => {
    mockDb.issueInterest.count.mockResolvedValue(0);

    const page = await BugDetailPage({
      params: Promise.resolve({ id: "1" }),
    });

    render(page);
    expect(screen.queryByText(/volunteered/)).not.toBeInTheDocument();
  });
});
