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
import { viewerBugScope } from "@/lib/tenant-viewer";
import LegacyIssuePage from "./page";

const bugFindFirst = vi.mocked(prisma.bug.findFirst);

/** The old /issues/<ref> address only redirects to /<project-slug>/<number> (#project-urls). */
describe("legacy /issues/<ref> links (#project-urls)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bugFindFirst.mockResolvedValue(null);
    vi.mocked(prisma.idea.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.bug.findUnique).mockResolvedValue(null);
  });

  it("permanently redirects a number to the issue's project URL, keeping the query", async () => {
    bugFindFirst.mockResolvedValueOnce({ number: 12, project: { slug: "ziki" } } as never);
    await expect(
      LegacyIssuePage({
        params: Promise.resolve({ id: "12" }),
        searchParams: Promise.resolve({ from: "email", tag: ["a", "b"] }),
      }),
    ).rejects.toThrow(/^REDIRECT \/ziki\/12\?from=email&tag=a&tag=b$/);
    expect(bugFindFirst).toHaveBeenCalledWith({
      where: { tenantId: "tenant-zedu", number: 12 },
      select: { number: true, project: { select: { slug: true } } },
    });
  });

  it("reads a prefixed number (ZE-12) the same way", async () => {
    bugFindFirst.mockResolvedValueOnce({ number: 12, project: { slug: "ziki" } } as never);
    await expect(LegacyIssuePage({ params: Promise.resolve({ id: "ZE-12" }) })).rejects.toThrow(/^REDIRECT \/ziki\/12$/);
  });

  it("redirects an old internal-id link, giving a comment permalink its anchor back", async () => {
    bugFindFirst.mockResolvedValueOnce({ number: 1, project: { slug: "ziki" } } as never);
    await expect(
      LegacyIssuePage({
        params: Promise.resolve({ id: "cmlegacy0001" }),
        searchParams: Promise.resolve({ comment: "c9" }),
      }),
    ).rejects.toThrow(/^REDIRECT \/ziki\/1\?comment=c9#comment-c9$/);
    expect(bugFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cmlegacy0001", tenantId: "tenant-zedu" } }),
    );
  });

  it("sends an old issue number that became an idea to the idea (#idea-table)", async () => {
    vi.mocked(prisma.idea.findFirst).mockResolvedValueOnce({ number: 4 } as never);
    await expect(LegacyIssuePage({ params: Promise.resolve({ id: "30" }) })).rejects.toThrow(/^REDIRECT \/ideas\/4$/);
  });

  it("is a 404 when the number is in neither the issues nor the ideas", async () => {
    await expect(LegacyIssuePage({ params: Promise.resolve({ id: "999" }) })).rejects.toThrow("NOT_FOUND");
  });

  it("looks nothing up by number without an organisation", async () => {
    vi.mocked(viewerBugScope).mockResolvedValueOnce({});
    await expect(LegacyIssuePage({ params: Promise.resolve({ id: "12" }) })).rejects.toThrow("NOT_FOUND");
    expect(bugFindFirst).not.toHaveBeenCalled();
  });
});
