import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(),
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  }),
}));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { ACTIVE_ROLE_COOKIE_NAME } from "@/lib/roles";
import { switchActiveRoleAction } from "./auth";

const mockAuth = vi.mocked(auth);
const findUser = vi.mocked(prisma.user.findUnique);
const setCookie = vi.fn();
const mockCookies = vi.mocked(cookies);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPER_ADMIN_EMAIL", "");
  vi.stubEnv("SUPER_ADMIN_EMAILS", "");
  vi.stubEnv("NODE_ENV", "test");
  setCookie.mockReset();
  mockCookies.mockResolvedValue({ set: setCookie, delete: vi.fn(), get: vi.fn() } as never);
});

describe("switchActiveRoleAction", () => {
  it("stores a user-scoped role and returns to the current page", async () => {
    mockAuth.mockResolvedValue({ user: { email: "Ada@Zedu.test", id: "u1" } } as never);
    findUser.mockResolvedValue({ id: "u1", role: "super_admin" } as never);

    await expect(switchActiveRoleAction("user", "/issues?q=login")).rejects.toMatchObject({
      to: "/issues?q=login",
    });

    expect(findUser).toHaveBeenCalledWith({
      where: { email: "ada@zedu.test" },
      select: { id: true, role: true },
    });
    expect(setCookie).toHaveBeenCalledWith(
      ACTIVE_ROLE_COOKIE_NAME,
      "user:u1",
      expect.objectContaining({ path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 7 }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("clears the override with the same cookie attributes when returning to the real role", async () => {
    mockAuth.mockResolvedValue({ user: { email: "ada@zedu.test", id: "u1" } } as never);
    findUser.mockResolvedValue({ id: "u1", role: "super_admin" } as never);

    await expect(switchActiveRoleAction("super_admin", "/admin/users")).rejects.toMatchObject({
      to: "/admin/users",
    });

    expect(setCookie).toHaveBeenCalledWith(
      ACTIVE_ROLE_COOKIE_NAME,
      "",
      expect.objectContaining({ path: "/", expires: new Date(0) }),
    );
  });

  it("refuses a role the person does not hold", async () => {
    mockAuth.mockResolvedValue({ user: { email: "lead@zedu.test", id: "u2" } } as never);
    findUser.mockResolvedValue({ id: "u2", role: "admin" } as never);

    await expect(switchActiveRoleAction("super_admin", "/issues")).resolves.toEqual({
      error: expect.any(String),
    });
    expect(setCookie).not.toHaveBeenCalled();
  });
});
