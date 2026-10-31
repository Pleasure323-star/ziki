import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "owner-1", role: "user" }),
}));
vi.mock("@/lib/membership-admin", () => ({
  changeMembershipRole: vi.fn(),
  removeMembership: vi.fn(),
  leaveMembership: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { tenant: { findUnique: vi.fn().mockResolvedValue({ slug: "ziki" }) } },
}));

import { revalidatePath } from "next/cache";
import { changeMembershipRole } from "@/lib/membership-admin";
import { setMemberRoleAction } from "./membership";

const change = vi.mocked(changeMembershipRole);

describe("setMemberRoleAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    change.mockResolvedValue({ ok: true });
  });

  it("changes the role inside the organization and does not take a site-wide role", async () => {
    const result = await setMemberRoleAction("tenant-ziki", "ada", "admin");

    expect(result).toEqual({ ok: true });
    expect(change).toHaveBeenCalledWith(
      expect.anything(),
      { id: "owner-1", role: "user" },
      { tenantId: "tenant-ziki", targetUserId: "ada", nextRole: "admin" },
    );
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/org", "layout");
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/tenants");
  });

  it("refuses to grant the owner role from this action", async () => {
    const result = await setMemberRoleAction("tenant-ziki", "ada", "owner");

    expect(result.error).toMatch(/owner/i);
    expect(change).not.toHaveBeenCalled();
  });

  it("returns the refusal when the person is not in this organization", async () => {
    change.mockResolvedValue({ ok: false, error: "That person isn't in this organization." });

    const result = await setMemberRoleAction("tenant-ziki", "zedu-user", "admin");

    expect(result).toEqual({ error: "That person isn't in this organization." });
  });
});
