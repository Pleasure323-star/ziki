import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SoleTenantOwnerError,
  UserHasReportedBugsError,
  deleteUserAccount,
  offboardUser,
} from "./user-offboarding";

describe("user offboarding (#356, #571)", () => {
  const mockClient = {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    bug: {
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    comment: {
      updateMany: vi.fn(),
    },
    bugActivity: {
      updateMany: vi.fn(),
    },
    membership: {
      findMany: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
    agent: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    agentApiKey: {
      updateMany: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws if the target user does not exist", async () => {
    mockClient.user.findUnique.mockResolvedValue(null);

    await expect(
      offboardUser(mockClient as never, "user-unknown"),
    ).rejects.toThrow('User with ID "user-unknown" not found.');
  });

  it("unassigns issues and deletes user when user has no reported bugs", async () => {
    mockClient.user.findUnique.mockResolvedValue({ id: "user-1" });
    mockClient.bug.updateMany.mockResolvedValue({ count: 3 });
    mockClient.bug.count.mockResolvedValue(0);
    mockClient.user.delete.mockResolvedValue({ id: "user-1" });

    const result = await offboardUser(mockClient as never, "user-1");

    expect(result).toEqual({
      ok: true,
      userId: "user-1",
      unassignedBugCount: 3,
      reassignedBugCount: 0,
    });
    expect(mockClient.bug.updateMany).toHaveBeenCalledWith({
      where: { assigneeId: "user-1" },
      data: { assigneeId: null },
    });
    expect(mockClient.user.delete).toHaveBeenCalledWith({
      where: { id: "user-1" },
    });
  });

  it("throws UserHasReportedBugsError if user reported bugs but no fallback is provided", async () => {
    mockClient.user.findUnique.mockResolvedValue({ id: "user-reporter" });
    mockClient.bug.count.mockResolvedValue(5);

    await expect(
      offboardUser(mockClient as never, "user-reporter"),
    ).rejects.toThrow(UserHasReportedBugsError);

    expect(mockClient.bug.updateMany).not.toHaveBeenCalled();
    expect(mockClient.user.delete).not.toHaveBeenCalled();
  });

  it("throws if the specified fallback reporter does not exist", async () => {
    mockClient.user.findUnique
      .mockResolvedValueOnce({ id: "user-reporter" })
      .mockResolvedValueOnce(null); // fallback lookup
    mockClient.bug.count.mockResolvedValue(2);

    await expect(
      offboardUser(mockClient as never, "user-reporter", {
        fallbackReporterId: "fallback-missing",
      }),
    ).rejects.toThrow('Fallback reporter user "fallback-missing" not found.');

    expect(mockClient.bug.updateMany).not.toHaveBeenCalled();
    expect(mockClient.user.delete).not.toHaveBeenCalled();
  });

  it("throws if fallbackReporterId is the user being offboarded", async () => {
    mockClient.user.findUnique.mockResolvedValue({ id: "user-same" });
    mockClient.bug.count.mockResolvedValue(2);

    await expect(
      offboardUser(mockClient as never, "user-same", {
        fallbackReporterId: "user-same",
      }),
    ).rejects.toThrow();

    expect(mockClient.bug.updateMany).not.toHaveBeenCalled();
    expect(mockClient.user.delete).not.toHaveBeenCalled();
  });

  it("reassigns reported bugs to fallback reporter, unassigns assigned bugs, and deletes user", async () => {
    mockClient.user.findUnique
      .mockResolvedValueOnce({ id: "user-retiring" })
      .mockResolvedValueOnce({ id: "admin-bot" });
    mockClient.bug.updateMany
      .mockResolvedValueOnce({ count: 4 }) // unassigned bugs
      .mockResolvedValueOnce({ count: 2 }); // reassigned reported bugs
    mockClient.bug.count.mockResolvedValue(2);
    mockClient.user.delete.mockResolvedValue({ id: "user-retiring" });

    const result = await offboardUser(mockClient as never, "user-retiring", {
      fallbackReporterId: "admin-bot",
    });

    expect(result).toEqual({
      ok: true,
      userId: "user-retiring",
      unassignedBugCount: 4,
      reassignedBugCount: 2,
    });
    expect(mockClient.bug.updateMany).toHaveBeenNthCalledWith(1, {
      where: { assigneeId: "user-retiring" },
      data: { assigneeId: null },
    });
    expect(mockClient.bug.updateMany).toHaveBeenNthCalledWith(2, {
      where: { reporterId: "user-retiring" },
      data: { reporterId: "admin-bot" },
    });
    // #423: the bugs filed for them move too, or the delete would fail.
    expect(mockClient.bug.updateMany).toHaveBeenNthCalledWith(3, {
      where: { beneficiaryUserId: "user-retiring" },
      data: { beneficiaryUserId: "admin-bot" },
    });
    expect(mockClient.bug.count).toHaveBeenCalledWith({
      where: { OR: [{ reporterId: "user-retiring" }, { beneficiaryUserId: "user-retiring" }] },
    });
    expect(mockClient.user.delete).toHaveBeenCalledWith({
      where: { id: "user-retiring" },
    });
  });

  it("wraps in transaction when client has $transaction method", async () => {
    const txMock = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: "user-tx" }),
        delete: vi.fn().mockResolvedValue({ id: "user-tx" }),
      },
      bug: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const clientWithTx = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(txMock)),
    };

    const result = await offboardUser(clientWithTx as never, "user-tx");
    expect(clientWithTx.$transaction).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.userId).toBe("user-tx");
  });

  describe("deleteUserAccount (#571)", () => {
    it("refuses deletion while user is the sole owner of an organization", async () => {
      mockClient.user.findUnique.mockResolvedValue({ id: "sole-owner" });
      mockClient.membership.findMany.mockResolvedValue([
        { tenantId: "tenant-solo", role: "owner", tenant: { id: "tenant-solo", name: "Solo Workspace" } },
      ]);
      mockClient.membership.count.mockResolvedValue(1);

      await expect(
        deleteUserAccount(mockClient as never, "sole-owner"),
      ).rejects.toThrow(SoleTenantOwnerError);

      expect(mockClient.agent.update).not.toHaveBeenCalled();
      expect(mockClient.membership.deleteMany).not.toHaveBeenCalled();
      expect(mockClient.user.delete).not.toHaveBeenCalled();
    });

    it("allows deletion when organization has other owners, revokes agents/keys, removes memberships and anonymises content", async () => {
      mockClient.user.findUnique
        .mockResolvedValueOnce({ id: "user-retiring" }) // deleteUserAccount user lookup
        .mockResolvedValueOnce({ id: "user-retiring" }) // runOffboard user lookup
        .mockResolvedValueOnce({ id: "anon-user" }) // getOrCreateAnonymizedUser lookup
        .mockResolvedValueOnce({ id: "anon-user" }); // fallback reporter verification

      mockClient.membership.findMany.mockResolvedValue([
        { tenantId: "tenant-multi", role: "owner", tenant: { id: "tenant-multi", name: "Multi Org" } },
      ]);
      mockClient.membership.count.mockResolvedValue(2); // 2 owners, safe to leave!

      mockClient.agent.findMany.mockResolvedValue([
        { id: "agent-1", tenantId: "tenant-multi" },
      ]);
      mockClient.agent.update.mockResolvedValue({ id: "agent-1" });
      mockClient.agentApiKey.updateMany.mockResolvedValue({ count: 1 });
      mockClient.membership.deleteMany.mockResolvedValue({ count: 1 });

      mockClient.bug.count.mockResolvedValue(1);
      mockClient.bug.updateMany
        .mockResolvedValueOnce({ count: 1 }) // assignee null
        .mockResolvedValueOnce({ count: 1 }) // reporterId -> anon
        .mockResolvedValueOnce({ count: 1 }); // beneficiaryUserId -> anon

      mockClient.comment.updateMany.mockResolvedValue({ count: 2 });
      mockClient.bugActivity.updateMany.mockResolvedValue({ count: 3 });
      mockClient.user.delete.mockResolvedValue({ id: "user-retiring" });

      const result = await deleteUserAccount(mockClient as never, "user-retiring");

      expect(result).toEqual({ ok: true, userId: "user-retiring" });

      // Agents and keys revoked
      expect(mockClient.agent.update).toHaveBeenCalledWith({
        where: { id: "agent-1" },
        data: { revokedAt: expect.any(Date) },
      });
      expect(mockClient.agentApiKey.updateMany).toHaveBeenCalledWith({
        where: { agent: { ownerUserId: "user-retiring" }, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });

      // Memberships removed
      expect(mockClient.membership.deleteMany).toHaveBeenCalledWith({
        where: { userId: "user-retiring" },
      });

      // Content anonymised
      expect(mockClient.bug.updateMany).toHaveBeenCalledWith({
        where: { reporterId: "user-retiring" },
        data: { reporterId: "anon-user" },
      });
      expect(mockClient.comment.updateMany).toHaveBeenCalledWith({
        where: { authorId: "user-retiring" },
        data: { authorId: "anon-user" },
      });
      expect(mockClient.bugActivity.updateMany).toHaveBeenCalledWith({
        where: { actorId: "user-retiring" },
        data: { actorId: "anon-user" },
      });

      // User deleted
      expect(mockClient.user.delete).toHaveBeenCalledWith({
        where: { id: "user-retiring" },
      });
    });
  });
});
