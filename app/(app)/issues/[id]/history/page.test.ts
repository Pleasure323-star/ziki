import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tenant-viewer", () => ({
  viewerBugScope: vi.fn(async () => ({ tenantId: "tenant-zedu" })),
}));
vi.mock("@/lib/tenant-context", () => ({
  currentTenantIdFor: vi.fn(async () => "tenant-zedu"),
}));
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: vi.fn(async () => ({ userId: "user-123" })),
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  permanentRedirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));
// The tenant-switch notice is not under test here.
vi.mock("@/components/issue-tenant-hint", () => ({ IssueTenantSwitch: () => null }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bug: { findFirst: vi.fn(), findUnique: vi.fn() },
    idea: { findFirst: vi.fn() },
    membership: { findFirst: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import LegacyIssueHistoryPage from "./page";

const bugFindFirst = vi.mocked(prisma.bug.findFirst);

describe("legacy /issues/<ref>/history links (#project-urls)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bugFindFirst.mockResolvedValue(null);
    vi.mocked(prisma.idea.findFirst).mockResolvedValue(null);
  });

  it("permanently redirects an old internal-id link to the project's history, keeping the query", async () => {
    bugFindFirst.mockResolvedValueOnce({ number: 7, project: { slug: "ziki" } } as never);
    await expect(
      LegacyIssueHistoryPage({
        params: Promise.resolve({ id: "cmlegacy0001" }),
        searchParams: Promise.resolve({ from: "email", tag: ["a", "b"] }),
      }),
    ).rejects.toThrow(/^REDIRECT \/ziki\/7\/history\?from=email&tag=a&tag=b$/);
  });

  it("redirects a number without a trailing ? when there is no query", async () => {
    bugFindFirst.mockResolvedValueOnce({ number: 7, project: { slug: "ziki" } } as never);
    await expect(LegacyIssueHistoryPage({ params: Promise.resolve({ id: "7" }) })).rejects.toThrow(
      /^REDIRECT \/ziki\/7\/history$/,
    );
  });

  it("is a 404 when nothing has that reference", async () => {
    await expect(LegacyIssueHistoryPage({ params: Promise.resolve({ id: "999" }) })).rejects.toThrow("NOT_FOUND");
  });
});
