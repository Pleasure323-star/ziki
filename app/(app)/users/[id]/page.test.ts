import { beforeEach, describe, expect, it, vi } from "vitest";

const currentTenantIdFor = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor,
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  requireUser: vi.fn(async () => ({ id: "viewer-1", role: "user" })),
}));

vi.mock("@/lib/points/leaderboard", () => ({
  pointTotals: vi.fn(async () => ({ points: 0, solvedTasks: 0 })),
}));

// #618: the page also reads the ledger balance; stub it so these specs stay
// about which issues a viewer may see.
vi.mock("@/lib/points/balance", () => ({
  pointBalance: vi.fn(async () => ({
    lifetime: { points: 0, entries: 0, from: null, to: null },
    period: { points: 0, entries: 0, from: null, to: null },
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    membership: { findFirst: vi.fn(), findUnique: vi.fn() },
    agent: { findMany: vi.fn() },
    issueClaim: { findMany: vi.fn() },
    bug: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import ProfilePage, { generateMetadata } from "./page";
import { pointEntries } from "@/lib/points/entries";
vi.mock("@/lib/points/entries", async original => ({
  ...await original<typeof import("@/lib/points/entries")>(),
  pointEntries: vi.fn(async () => ({ items: [], nextCursor: null })),
}));

const person = {
  id: "reporter-1",
  name: "Ada",
  role: "user",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue(person as never);
  vi.mocked(prisma.bug.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.bug.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.bug.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.agent.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.issueClaim.findMany).mockResolvedValue([] as never);
  // By default the viewer and the person share a tenant.
  vi.mocked(prisma.membership.findFirst).mockResolvedValue({ id: "m-1" } as never);
  // #618: the viewer is an ordinary member, so no wallet is shown.
  vi.mocked(prisma.membership.findUnique).mockResolvedValue({ role: "member" } as never);
});

describe("profile issues (#439)", () => {
  it("shows a new account with no membership no issues", async () => {
    currentTenantIdFor.mockResolvedValue(null);

    await ProfilePage({ params: Promise.resolve({ id: person.id }) });

    const wheres = [
      ...vi.mocked(prisma.bug.findMany).mock.calls.map((call) => call[0]?.where),
      ...vi.mocked(prisma.bug.groupBy).mock.calls.map((call) => call[0]?.where),
      ...vi.mocked(prisma.bug.count).mock.calls.map((call) => call[0]?.where),
    ];
    expect(wheres).toHaveLength(4);
    for (const where of wheres) {
      expect(where).toMatchObject({ tenantId: { in: [] }, isDeleted: false });
    }
  });

  it("limits a member to their own workspace", async () => {
    currentTenantIdFor.mockResolvedValue("tenant-zedu");

    await ProfilePage({ params: Promise.resolve({ id: person.id }) });

    expect(prisma.bug.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ reporterId: person.id, tenantId: "tenant-zedu" }),
      }),
    );
    expect(prisma.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-zedu", ownerUserId: { in: [person.id] }, revokedAt: null },
    }));
  });
});

describe("profiles outside your tenants (#503)", () => {
  beforeEach(() => {
    vi.mocked(notFound).mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
    currentTenantIdFor.mockResolvedValue("tenant-acme");
  });

  it("404s when the viewer shares no tenant with the person", async () => {
    vi.mocked(prisma.membership.findFirst).mockResolvedValue(null as never);

    await expect(ProfilePage({ params: Promise.resolve({ id: person.id }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(prisma.membership.findFirst).toHaveBeenCalledWith({
      where: { userId: person.id, tenant: { memberships: { some: { userId: "viewer-1" } } } },
      select: { id: true },
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.bug.findMany).not.toHaveBeenCalled();
  });

  it("keeps the name out of the tab title too", async () => {
    vi.mocked(prisma.membership.findFirst).mockResolvedValue(null as never);

    const meta = await generateMetadata({ params: Promise.resolve({ id: person.id }) });
    expect(String(meta.title)).not.toContain("Ada");
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("still shows the profile when they share a tenant", async () => {
    await ProfilePage({ params: Promise.resolve({ id: person.id }) });
    expect(notFound).not.toHaveBeenCalled();
    const meta = await generateMetadata({ params: Promise.resolve({ id: person.id }) });
    expect(meta.title).toBe("Ada");
  });
});


describe("owner-only points history (#461)", () => {
  beforeEach(() => {
    vi.mocked(notFound).mockImplementation(() => { throw new Error("NEXT_NOT_FOUND"); });
    currentTenantIdFor.mockResolvedValue("tenant-zedu");
  });
  it("does not query ledger entries when viewing someone else's profile", async () => {
    await ProfilePage({ params: Promise.resolve({ id: person.id }) });
    expect(pointEntries).not.toHaveBeenCalled();
  });
  it("loads the authenticated owner's entries with requested date filters", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ ...person, id: "viewer-1" } as never);
    await ProfilePage({ params: Promise.resolve({ id: "viewer-1" }), searchParams: Promise.resolve({ from: "2026-10-01", to: "2026-10-22" }) });
    expect(pointEntries).toHaveBeenCalledWith(prisma, { tenantId: "tenant-zedu", userId: "viewer-1" }, { from: "2026-10-01", to: "2026-10-22", limit: 25 });
  });
  it("does not query the ledger with an invalid cursor", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ ...person, id: "viewer-1" } as never);
    await ProfilePage({ params: Promise.resolve({ id: "viewer-1" }), searchParams: Promise.resolve({ cursor: "invalid" }) });
    expect(pointEntries).not.toHaveBeenCalled();
  });
});
