import { describe, expect, it, vi } from "vitest";
import { isOfferExpired, OFFER_TTL_MS } from "@/lib/agent-api/offer";

describe("ticket offers", () => {
  it("expires an offer at 30 minutes, but not before", () => {
    const offeredAt = new Date("2026-10-19T12:00:00.000Z");
    const start = offeredAt.getTime();
    expect(isOfferExpired(offeredAt, start + OFFER_TTL_MS - 1)).toBe(false);
    expect(isOfferExpired(offeredAt, start + OFFER_TTL_MS)).toBe(true);
    expect(isOfferExpired(null, start)).toBe(true);
    expect(isOfferExpired(offeredAt, start + 119_999, 120_000)).toBe(false);
    expect(isOfferExpired(offeredAt, start + 120_000, 120_000)).toBe(true);
  });

  it("sweeps expired offers and calls expireOffer for each (#681)", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { sweepExpiredOffers } = await import("@/lib/agent-api/offer");

    vi.spyOn(prisma.projectWorkflow, "findUnique").mockResolvedValue(null);
    const findManySpy = vi.spyOn(prisma.issueClaim, "findMany").mockResolvedValueOnce([
      { id: "claim-1", offeredAt: new Date(Date.now() - 1_900_000), bug: { projectId: "proj-1" } } as never,
      { id: "claim-2", offeredAt: new Date(Date.now() - 1_900_000), bug: { projectId: "proj-1" } } as never,
    ]);
    const txMock = {
      issueClaim: {
        findUnique: vi.fn().mockResolvedValue({
          id: "claim-1",
          bugId: "bug-1",
          status: "offered",
          offeredAt: new Date(Date.now() - 1_900_000),
          releasedAt: null,
          agentId: "agent-1",
          beneficiaryUserId: "user-1",
          bug: { tenantId: "tenant-1", id: "bug-1", title: "Bug 1", projectId: "proj-1", assigneeId: null },
        }),
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
      bug: {
        findFirst: vi.fn(),
      },
      membership: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      agentEvent: {
        create: vi.fn().mockResolvedValue({ id: "e1" }),
      },
      webhookSubscription: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "bug-1" }]),
    };
    vi.spyOn(prisma, "$transaction").mockImplementation(async (fn: unknown) =>
      (fn as (tx: unknown) => unknown)(txMock),
    );

    const result = await sweepExpiredOffers("tenant-1");
    expect(findManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "offered",
          releasedAt: null,
          bug: { tenantId: "tenant-1" },
        }),
      }),
    );
    expect(result.expired).toBe(2);
  });

  it("releases an expired offer without offering the issue to anyone else (#bids-only-offers)", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { expireOffer } = await import("@/lib/agent-api/offer");

    const txMock = {
      issueClaim: {
        findUnique: vi.fn().mockResolvedValue({
          id: "claim-1",
          bugId: "bug-1",
          status: "offered",
          offeredAt: new Date(Date.now() - 1_900_000),
          releasedAt: null,
          agentId: "agent-1",
          beneficiaryUserId: "user-1",
          bug: { tenantId: "tenant-1", id: "bug-1", title: "Bug 1", projectId: "proj-1", assigneeId: null },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      issueBid: {
        findFirst: vi.fn().mockResolvedValue({ id: "bid-1" }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "bug-1" }]),
      agentEvent: {
        create: vi.fn().mockResolvedValue({ id: "e1" }),
      },
      webhookSubscription: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      membership: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    vi.spyOn(prisma, "$transaction").mockImplementation(async (fn: unknown) =>
      (fn as (tx: unknown) => unknown)(txMock),
    );

    const didExpire = await expireOffer("claim-1");
    expect(didExpire).toBe(true);
    expect(txMock.issueClaim.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "claim-1" },
        data: expect.objectContaining({ status: "released", releaseReason: "expired" }),
      }),
    );
    expect(txMock.membership.findMany).not.toHaveBeenCalled();
  });

  it("rejects offer acceptance if the issue already has an active claim (#662)", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { acceptOffer } = await import("@/lib/agent-api/offer");
    const { IssueApiError } = await import("@/lib/agent-api/issues");

    const txMock = {
      issueClaim: {
        findUnique: vi.fn().mockResolvedValue({
          id: "claim-1",
          bugId: "bug-1",
          agentId: "agent-1",
          beneficiaryUserId: "user-1",
          status: "offered",
          offeredAt: new Date(),
          releasedAt: null,
          beneficiary: { name: "Agent User" },
          bug: { id: "bug-1", title: "Bug 1", status: "open", assigneeId: null, tenantId: "tenant-1", projectId: "proj-1", voteCount: 5, assignee: null },
        }),
        findFirst: vi.fn().mockResolvedValue({
          id: "claim-active",
          bugId: "bug-1",
          status: "active",
          releasedAt: null,
        }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "bug-1" }]),
    };
    vi.spyOn(prisma, "$transaction").mockImplementation(async (fn: unknown) =>
      (fn as (tx: unknown) => unknown)(txMock),
    );

    const agent = { agentId: "agent-1", ownerId: "user-1", tenantId: "tenant-1", level: "working" as const } as unknown as import("@/lib/agents/require-agent").AgentContext;
    await expect(acceptOffer(agent, "claim-1")).rejects.toThrow(IssueApiError);
    await expect(acceptOffer(agent, "claim-1")).rejects.toMatchObject({
      status: 409,
      message: "This issue already has an active claim.",
    });
  });

  it("maps P2002 unique constraint violation to 409 conflict during acceptOffer (#662)", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { Prisma } = await import("@prisma/client");
    const { acceptOffer } = await import("@/lib/agent-api/offer");
    const { IssueApiError } = await import("@/lib/agent-api/issues");

    const p2002Error = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5.0.0",
    });

    vi.spyOn(prisma, "$transaction").mockRejectedValue(p2002Error);

    const agent = { agentId: "agent-1", ownerId: "user-1", tenantId: "tenant-1", level: "working" as const } as unknown as import("@/lib/agents/require-agent").AgentContext;
    await expect(acceptOffer(agent, "claim-1")).rejects.toThrow(IssueApiError);
    await expect(acceptOffer(agent, "claim-1")).rejects.toMatchObject({
      status: 409,
      message: "This issue already has an active claim.",
    });
  });
});

