import { describe, expect, it, vi } from "vitest";
import {
  changeMembershipRole,
  leaveMembership,
  MEMBERSHIP_ADMIN_ERRORS,
  refuseLeave,
  refuseMemberRemoval,
  refuseMembershipRoleChange,
  removeMembership,
} from "./membership-admin";

describe("refuseMembershipRoleChange", () => {
  const member = { role: "member" as const };
  const admin = { role: "admin" as const };
  const owner = { role: "owner" as const };

  it("lets an owner promote a member and demote an admin", () => {
    expect(
      refuseMembershipRoleChange({
        actorIsOwner: true,
        actorIsSuperAdmin: false,
        target: member,
        nextRole: "admin",
        ownerCount: 1,
      }),
    ).toBeNull();
    expect(
      refuseMembershipRoleChange({
        actorIsOwner: true,
        actorIsSuperAdmin: false,
        target: admin,
        nextRole: "member",
        ownerCount: 1,
      }),
    ).toBeNull();
  });

  it("lets the site super admin change roles without being an owner", () => {
    expect(
      refuseMembershipRoleChange({
        actorIsOwner: false,
        actorIsSuperAdmin: true,
        target: member,
        nextRole: "admin",
        ownerCount: 1,
      }),
    ).toBeNull();
  });

  it("refuses a member, a missing person, and a role they already have", () => {
    expect(
      refuseMembershipRoleChange({
        actorIsOwner: false,
        actorIsSuperAdmin: false,
        target: member,
        nextRole: "admin",
        ownerCount: 1,
      }),
    ).toBe("not-allowed");
    expect(
      refuseMembershipRoleChange({
        actorIsOwner: true,
        actorIsSuperAdmin: false,
        target: null,
        nextRole: "admin",
        ownerCount: 1,
      }),
    ).toBe("not-found");
    expect(
      refuseMembershipRoleChange({
        actorIsOwner: true,
        actorIsSuperAdmin: false,
        target: admin,
        nextRole: "admin",
        ownerCount: 1,
      }),
    ).toBe("same-role");
  });

  it("never makes someone an owner from this action, and never demotes the last owner", () => {
    expect(
      refuseMembershipRoleChange({
        actorIsOwner: true,
        actorIsSuperAdmin: false,
        target: admin,
        nextRole: "owner",
        ownerCount: 2,
      }),
    ).toBe("not-allowed");
    expect(
      refuseMembershipRoleChange({
        actorIsOwner: true,
        actorIsSuperAdmin: false,
        target: owner,
        nextRole: "admin",
        ownerCount: 1,
      }),
    ).toBe("last-owner");
    expect(
      refuseMembershipRoleChange({
        actorIsOwner: true,
        actorIsSuperAdmin: false,
        target: owner,
        nextRole: "admin",
        ownerCount: 2,
      }),
    ).toBeNull();
  });
});

describe("refuseMemberRemoval", () => {
  it("lets an owner remove a member and an admin", () => {
    expect(
      refuseMemberRemoval({
        actorId: "owner",
        actorIsOwner: true,
        actorIsAdmin: false,
        actorIsSuperAdmin: false,
        target: { userId: "ada", role: "admin" },
        ownerCount: 1,
      }),
    ).toBeNull();
  });

  it("lets an admin remove a member, not another admin or the last owner", () => {
    expect(
      refuseMemberRemoval({
        actorId: "admin",
        actorIsOwner: false,
        actorIsAdmin: true,
        actorIsSuperAdmin: false,
        target: { userId: "ada", role: "member" },
        ownerCount: 1,
      }),
    ).toBeNull();
    expect(
      refuseMemberRemoval({
        actorId: "admin",
        actorIsOwner: false,
        actorIsAdmin: true,
        actorIsSuperAdmin: false,
        target: { userId: "ada", role: "admin" },
        ownerCount: 1,
      }),
    ).toBe("admin-removes-member-only");
    expect(
      refuseMemberRemoval({
        actorId: "admin",
        actorIsOwner: false,
        actorIsAdmin: true,
        actorIsSuperAdmin: false,
        target: { userId: "ada", role: "owner" },
        ownerCount: 1,
      }),
    ).toBe("last-owner");
  });

  it("refuses removing yourself", () => {
    expect(
      refuseMemberRemoval({
        actorId: "ada",
        actorIsOwner: true,
        actorIsAdmin: false,
        actorIsSuperAdmin: false,
        target: { userId: "ada", role: "member" },
        ownerCount: 1,
      }),
    ).toBe("cannot-remove-self");
  });
});

describe("refuseLeave", () => {
  it("lets a member or a spare owner leave", () => {
    expect(refuseLeave({ target: { role: "member" }, ownerCount: 1 })).toBeNull();
    expect(refuseLeave({ target: { role: "owner" }, ownerCount: 2 })).toBeNull();
  });

  it("keeps the last owner", () => {
    expect(refuseLeave({ target: { role: "owner" }, ownerCount: 1 })).toBe("last-owner");
    expect(refuseLeave({ target: null, ownerCount: 0 })).toBe("not-found");
  });
});

describe("changeMembershipRole", () => {
  it("updates the organization role and records the change", async () => {
    const membership = {
      findUnique: vi.fn(async ({ where }: { where: { tenantId_userId: { userId: string } } }) => {
        if (where.tenantId_userId.userId === "owner") return { id: "mem-owner", role: "owner" };
        return { id: "mem-ada", role: "member" };
      }),
      count: vi.fn(async () => 1),
      update: vi.fn(async () => ({})),
    };
    const membershipChange = { create: vi.fn(async () => ({})) };
    const user = { update: vi.fn(async () => ({})) };
    const db = {
      membership,
      membershipChange,
      user,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ membership, membershipChange, user }),
    };

    const result = await changeMembershipRole(db as never, { id: "owner", role: "user" }, {
      tenantId: "tenant-ziki",
      targetUserId: "ada",
      nextRole: "admin",
    });

    expect(result).toEqual({ ok: true });
    expect(membership.update).toHaveBeenCalledWith({
      where: { id: "mem-ada" },
      data: { role: "admin" },
    });
    expect(user.update).toHaveBeenCalledWith({
      where: { id: "ada" },
      data: { sessionVersion: { increment: 1 } },
    });
    expect(membershipChange.create).toHaveBeenCalledWith({
      data: {
        tenantId: "tenant-ziki",
        actorUserId: "owner",
        targetUserId: "ada",
        action: "role_changed",
        fromRole: "member",
        toRole: "admin",
      },
    });
  });

  it("does not write when the actor cannot change roles", async () => {
    const membership = {
      findUnique: vi.fn(async ({ where }: { where: { tenantId_userId: { userId: string } } }) => {
        if (where.tenantId_userId.userId === "ada") return { id: "mem-ada", role: "member" };
        return { id: "mem-bob", role: "member" };
      }),
      count: vi.fn(async () => 1),
      update: vi.fn(),
    };
    const db = {
      membership,
      membershipChange: { create: vi.fn() },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ membership, membershipChange: { create: vi.fn() } }),
    };

    const result = await changeMembershipRole(db as never, { id: "bob", role: "admin" }, {
      tenantId: "tenant-ziki",
      targetUserId: "ada",
      nextRole: "admin",
    });

    expect(result).toEqual({ ok: false, error: MEMBERSHIP_ADMIN_ERRORS["not-allowed"] });
    expect(membership.update).not.toHaveBeenCalled();
  });
});

describe("removeMembership and leaveMembership", () => {
  function dbFor(targetRole: "member" | "owner") {
    const membership = {
      findUnique: vi.fn(async ({ where }: { where: { tenantId_userId: { userId: string } } }) => {
        const userId = where.tenantId_userId.userId;
        if (userId === "owner") return { id: "mem-owner", role: "owner", userId };
        return { id: `mem-${userId}`, role: targetRole, userId };
      }),
      count: vi.fn(async () => 1),
      delete: vi.fn(async () => ({})),
    };
    const membershipChange = { create: vi.fn(async () => ({})) };
    return {
      membership,
      membershipChange,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ membership, membershipChange }),
    };
  }

  it("removes a member and records who did it", async () => {
    const db = dbFor("member");
    const result = await removeMembership(db as never, { id: "owner", role: "user" }, {
      tenantId: "tenant-ziki",
      targetUserId: "ada",
    });
    expect(result).toEqual({ ok: true });
    expect(db.membership.delete).toHaveBeenCalledWith({ where: { id: "mem-ada" } });
    expect(db.membershipChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "removed", fromRole: "member", toRole: null }),
    });
  });

  it("refuses to let the last owner leave", async () => {
    const db = dbFor("owner");
    const result = await leaveMembership(db as never, { id: "owner", role: "user" }, "tenant-ziki");
    expect(result).toEqual({ ok: false, error: MEMBERSHIP_ADMIN_ERRORS["last-owner"] });
    expect(db.membership.delete).not.toHaveBeenCalled();
  });
});
