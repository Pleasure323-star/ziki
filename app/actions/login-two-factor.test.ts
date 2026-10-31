import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn(async () => new Headers()) }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  }),
}));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth-mode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-mode")>()),
  isPasswordAuthEnabled: () => true,
}));

import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { loginAction } from "./auth";

const signInMock = vi.mocked(signIn);

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function authError(code: string) {
  return Object.assign(new AuthError("sign in failed"), { code });
}

beforeEach(() => vi.clearAllMocks());

describe("loginAction second step (#648)", () => {
  it("passes the typed code to the credentials sign-in", async () => {
    signInMock.mockResolvedValueOnce(undefined as never);
    await expect(
      loginAction(undefined, form({ email: "a@b.co", password: "pw", totp: "123456", callbackUrl: "/issues" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(signInMock).toHaveBeenCalledWith("credentials", {
      email: "a@b.co",
      password: "pw",
      totp: "123456",
      redirect: false,
    });
  });

  it("asks for a code when the password was right and the account has two-factor on", async () => {
    signInMock.mockRejectedValueOnce(authError("two_factor_required"));
    const result = await loginAction(undefined, form({ email: "a@b.co", password: "pw" }));
    expect(result).toEqual({ error: expect.any(String), needsCode: true });
  });

  it("keeps asking after a wrong code", async () => {
    signInMock.mockRejectedValueOnce(authError("two_factor_invalid"));
    const result = await loginAction(undefined, form({ email: "a@b.co", password: "pw", totp: "000000" }));
    expect(result?.needsCode).toBe(true);
    expect(result?.error).toEqual(expect.any(String));
  });

  it("still gives the one generic message for a bad email or password", async () => {
    signInMock.mockRejectedValueOnce(authError("credentials"));
    const result = await loginAction(undefined, form({ email: "a@b.co", password: "wrong" }));
    expect(result).toEqual({ error: expect.any(String), field: "email" });
    expect(result).not.toHaveProperty("needsCode");
  });
});
