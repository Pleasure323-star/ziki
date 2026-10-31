import { describe, expect, it } from "vitest";
import {
  isAdmin,
  isSuperAdmin,
  resolveEffectiveRole,
} from "./roles";

describe("isAdmin", () => {
  it("returns true for admin and super_admin", () => {
    expect(isAdmin("admin")).toBe(true);
    expect(isAdmin("super_admin")).toBe(true);
  });

  it("returns false for user and missing roles", () => {
    expect(isAdmin("user")).toBe(false);
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });
});

describe("isSuperAdmin", () => {
  it("returns true only for super_admin", () => {
    expect(isSuperAdmin("super_admin")).toBe(true);
    expect(isSuperAdmin("admin")).toBe(false);
    expect(isSuperAdmin("user")).toBe(false);
  });
});

describe("resolveEffectiveRole", () => {
  it("allows real super admin to switch to user", () => {
    const role = resolveEffectiveRole({
      isRealSuperAdmin: true,
      baseRole: "super_admin",
      activeRoleOverride: "user",
    });
    expect(role).toBe("user");
  });

  it("allows real super admin to switch to admin", () => {
    const role = resolveEffectiveRole({
      isRealSuperAdmin: true,
      baseRole: "super_admin",
      activeRoleOverride: "admin",
    });
    expect(role).toBe("admin");
  });

  it("returns baseRole if override is super_admin", () => {
    const role = resolveEffectiveRole({
      isRealSuperAdmin: true,
      baseRole: "super_admin",
      activeRoleOverride: "super_admin",
    });
    expect(role).toBe("super_admin");
  });

  it("ignores cookie override if user is not a real super admin", () => {
    const role = resolveEffectiveRole({
      isRealSuperAdmin: false,
      baseRole: "user",
      activeRoleOverride: "super_admin",
    });
    expect(role).toBe("user");
  });

  it("ignores invalid cookie override values", () => {
    const role = resolveEffectiveRole({
      isRealSuperAdmin: true,
      baseRole: "super_admin",
      activeRoleOverride: "hacker_role",
    });
    expect(role).toBe("super_admin");
  });

  it("allows real admin to switch to user", () => {
    const role = resolveEffectiveRole({
      isRealSuperAdmin: false,
      baseRole: "admin",
      activeRoleOverride: "user",
    });
    expect(role).toBe("user");
  });

  it("allows real admin to keep or switch back to admin", () => {
    const role = resolveEffectiveRole({
      isRealSuperAdmin: false,
      baseRole: "admin",
      activeRoleOverride: "admin",
    });
    expect(role).toBe("admin");
  });

  it("prevents real admin from switching to super_admin", () => {
    const role = resolveEffectiveRole({
      isRealSuperAdmin: false,
      baseRole: "admin",
      activeRoleOverride: "super_admin",
    });
    expect(role).toBe("admin");
  });

  it("prevents normal user from switching to admin", () => {
    const role = resolveEffectiveRole({
      isRealSuperAdmin: false,
      baseRole: "user",
      activeRoleOverride: "admin",
    });
    expect(role).toBe("user");
  });

  it("defaults to baseRole when no override is set", () => {
    const role = resolveEffectiveRole({
      isRealSuperAdmin: true,
      baseRole: "super_admin",
      activeRoleOverride: undefined,
    });
    expect(role).toBe("super_admin");
  });

  describe("user-scoped active role cookie (#131)", () => {
    it("applies role override when cookie user id matches current user", () => {
      const role = resolveEffectiveRole({
        isRealSuperAdmin: true,
        baseRole: "super_admin",
        activeRoleOverride: "user:user_123",
        currentUserId: "user_123",
      });
      expect(role).toBe("user");
    });

    it("ignores role override when cookie belongs to a different user", () => {
      const role = resolveEffectiveRole({
        isRealSuperAdmin: false,
        baseRole: "admin",
        activeRoleOverride: "user:user_other",
        currentUserId: "user_alice",
      });
      expect(role).toBe("admin");
    });

    it("still supports unscoped role override without user id", () => {
      const role = resolveEffectiveRole({
        isRealSuperAdmin: false,
        baseRole: "admin",
        activeRoleOverride: "user",
        currentUserId: "user_alice",
      });
      expect(role).toBe("user");
    });
  });
});


