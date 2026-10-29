import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerInterest,
  withdrawInterest,
  countVolunteers,
  listVolunteers,
} from "./interest";
import { IssueApiError } from "@/lib/agent-api/errors";

const db = vi.hoisted(() => ({
  bug: { findFirst: vi.fn(), findUnique: vi.fn() },
  issueClaim: { findFirst: vi.fn() },
  issueInterest: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  agentEvent: { create: vi.fn() },
  webhookSubscription: { findMany: vi.fn() },
  webhookDelivery: { createMany: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));

vi.mock("@/lib/agent-api/confirmations", () => ({
  isConfirmed: vi.fn(),
}));

import { isConfirmed } from "@/lib/agent-api/confirmations";

describe("issue interest registration and withdrawal (#589)", () => {
  const agentCtx = {
    agentId: "agent-1",
    name: "agent-one",
    ownerId: "user-alice",
    tenantId: "tenant-zedu",
    level: "working" as const,
    burst: false,
    keyId: "k1",
  };

  const bugId = "bug-100";
  const projectId = "proj-1";

  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
    db.$queryRaw.mockResolvedValue([{ id: bugId }]);
    db.bug.findFirst.mockResolvedValue({
      id: bugId,
      projectId,
      tenantId: "tenant-zedu",
      status: "open",
      isDeleted: false,
    });
    db.issueClaim.findFirst.mockResolvedValue(null);
    db.agentEvent.create.mockResolvedValue({ id: "evt-1" });
    db.webhookSubscription.findMany.mockResolvedValue([]);
    vi.mocked(isConfirmed).mockResolvedValue(true);
  });

  describe("registerInterest", () => {
    it("registers interest on a confirmed open issue and publishes issue.interest", async () => {
      db.issueInterest.findUnique.mockResolvedValue(null);
      db.issueInterest.create.mockResolvedValue({
        id: "interest-1",
        bugId,
        agentId: "agent-1",
        beneficiaryUserId: "user-alice",
        note: "I have experience with this subsystem",
        createdAt: new Date("2026-10-20T12:00:00.000Z"),
        withdrawnAt: null,
      });

      const result = await registerInterest(
        agentCtx,
        projectId,
        bugId,
        "I have experience with this subsystem",
      );

      expect(result.created).toBe(true);
      expect(result.interest.id).toBe("interest-1");
      expect(db.issueInterest.create).toHaveBeenCalledWith({
        data: {
          bugId,
          agentId: "agent-1",
          beneficiaryUserId: "user-alice",
          note: "I have experience with this subsystem",
        },
      });

      expect(db.agentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "issue.interest",
            tenantId: "tenant-zedu",
            bugId,
            payload: expect.objectContaining({
              issueId: bugId,
              agentId: "agent-1",
              beneficiaryUserId: "user-alice",
              note: "I have experience with this subsystem",
            }),
          }),
        }),
      );
    });

    it("is idempotent: repeat calls return the existing active interest record", async () => {
      const existing = {
        id: "interest-1",
        bugId,
        agentId: "agent-1",
        beneficiaryUserId: "user-alice",
        note: "existing note",
        createdAt: new Date(),
        withdrawnAt: null,
      };
      db.issueInterest.findUnique.mockResolvedValue(existing);

      const result = await registerInterest(agentCtx, projectId, bugId);
      expect(result.created).toBe(false);
      expect(result.interest).toBe(existing);
      expect(db.issueInterest.create).not.toHaveBeenCalled();
      expect(db.agentEvent.create).not.toHaveBeenCalled();
    });

    it("restores interest when previously withdrawn", async () => {
      const withdrawn = {
        id: "interest-1",
        bugId,
        agentId: "agent-1",
        beneficiaryUserId: "user-alice",
        note: null,
        createdAt: new Date(),
        withdrawnAt: new Date(Date.now() - 50_000),
      };
      db.issueInterest.findUnique.mockResolvedValue(withdrawn);
      db.issueInterest.update.mockResolvedValue({
        ...withdrawn,
        withdrawnAt: null,
        note: "new note",
      });

      const result = await registerInterest(agentCtx, projectId, bugId, "new note");
      expect(result.created).toBe(true);
      expect(db.issueInterest.update).toHaveBeenCalledWith({
        where: { id: "interest-1" },
        data: expect.objectContaining({
          withdrawnAt: null,
          note: "new note",
        }),
      });
      expect(db.agentEvent.create).toHaveBeenCalled();
    });

    it("rejects unconfirmed issues with 409", async () => {
      vi.mocked(isConfirmed).mockResolvedValue(false);
      await expect(
        registerInterest(agentCtx, projectId, bugId),
      ).rejects.toThrowError(new IssueApiError(409, "The issue must be confirmed before an agent can volunteer."));
    });

    it("rejects non-open issues with 409", async () => {
      db.bug.findFirst.mockResolvedValue({
        id: bugId,
        projectId,
        tenantId: "tenant-zedu",
        status: "resolved",
        isDeleted: false,
      });
      await expect(
        registerInterest(agentCtx, projectId, bugId),
      ).rejects.toThrowError(new IssueApiError(409, "Only open issues can take volunteers."));
    });

    it("rejects issues with an active claim with 409", async () => {
      db.issueClaim.findFirst.mockResolvedValue({ id: "active-claim" });
      await expect(
        registerInterest(agentCtx, projectId, bugId),
      ).rejects.toThrowError(new IssueApiError(409, "This issue is already being worked."));
    });
  });

  describe("withdrawInterest", () => {
    it("withdraws an active interest by setting withdrawnAt", async () => {
      const active = {
        id: "interest-1",
        bugId,
        agentId: "agent-1",
        beneficiaryUserId: "user-alice",
        withdrawnAt: null,
        bug: { tenantId: "tenant-zedu", projectId, isDeleted: false },
      };
      db.issueInterest.findUnique.mockResolvedValue(active);
      db.issueInterest.update.mockResolvedValue({
        ...active,
        withdrawnAt: new Date(),
      });

      const result = await withdrawInterest(agentCtx, projectId, bugId);
      expect(result.withdrawn).toBe(true);
      expect(db.issueInterest.update).toHaveBeenCalledWith({
        where: { id: "interest-1" },
        data: expect.objectContaining({ withdrawnAt: expect.any(Date) }),
      });
    });

    it("is idempotent: repeat withdraw calls succeed", async () => {
      const alreadyWithdrawn = {
        id: "interest-1",
        bugId,
        agentId: "agent-1",
        beneficiaryUserId: "user-alice",
        withdrawnAt: new Date(),
        bug: { tenantId: "tenant-zedu", projectId, isDeleted: false },
      };
      db.issueInterest.findUnique.mockResolvedValue(alreadyWithdrawn);

      const result = await withdrawInterest(agentCtx, projectId, bugId);
      expect(result.withdrawn).toBe(true);
      expect(db.issueInterest.update).not.toHaveBeenCalled();
    });

    it("returns 404 when interest not found", async () => {
      db.issueInterest.findUnique.mockResolvedValue(null);
      await expect(withdrawInterest(agentCtx, projectId, bugId)).rejects.toThrowError(
        new IssueApiError(404, "Interest not found."),
      );
    });
  });

  describe("countVolunteers and listVolunteers", () => {
    it("counts non-withdrawn volunteers and excludes revoked agents (#510)", async () => {
      db.issueInterest.count.mockResolvedValue(3);
      const count = await countVolunteers(bugId, db as never);
      expect(count).toBe(3);
      expect(db.issueInterest.count).toHaveBeenCalledWith({
        where: { bugId, withdrawnAt: null, agent: { revokedAt: null } },
      });
    });

    it("lists active volunteers with agent names and excludes revoked agents (#510)", async () => {
      const now = new Date();
      db.issueInterest.findMany.mockResolvedValue([
        {
          id: "int-1",
          agentId: "agent-1",
          beneficiaryUserId: "user-alice",
          note: "hi",
          createdAt: now,
          agent: { name: "Agent Alpha" },
        },
      ]);

      const volunteers = await listVolunteers(agentCtx, projectId, bugId, db as never);
      expect(volunteers).toHaveLength(1);
      expect(volunteers[0].agent.name).toBe("Agent Alpha");
      expect(db.issueInterest.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { bugId, withdrawnAt: null, agent: { revokedAt: null } },
      }));
    });
  });
});
