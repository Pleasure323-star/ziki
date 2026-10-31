import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(),
  headers: vi.fn(async () => new Headers({ "x-forwarded-for": "203.0.113.7" })),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  }),
}));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/mail", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/mail")>();
  return { ...real, sendMail: vi.fn() };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(), create: vi.fn() },
    passwordResetToken: { findUnique: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "@/lib/prisma";
import { sendMail } from "@/lib/mail";
import { hashResetToken } from "@/lib/password-reset";
import { resetRateLimits } from "@/lib/rate-limit";
import { signIn } from "@/auth";
import { forgotPasswordAction, googleSignInAction, resetPasswordAction, signupAction } from "./auth";

const db = prisma as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  passwordResetToken: { findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  vi.stubEnv("AUTH_PASSWORD_LOGIN", "true");
  // Some tests stub NODE_ENV=production, which would otherwise pick the
  // shared Postgres store (#296); these tests are about the actions.
  vi.stubEnv("RATE_LIMIT_STORE", "memory");
});
afterEach(() => vi.unstubAllEnvs());

describe("googleSignInAction", () => {
  it("falls back to the overview when no callback is given", async () => {
    await googleSignInAction();
    expect(signIn).toHaveBeenCalledWith("google", { redirectTo: "/dashboard" });
  });

  it("keeps a callback passed by the form", async () => {
    await googleSignInAction(form({ callbackUrl: "/issues/ZE-12" }));
    expect(signIn).toHaveBeenCalledWith("google", { redirectTo: "/issues/ZE-12" });
  });
});

describe("forgotPasswordAction (#210)", () => {
  it("in production without SMTP, says emails aren't available, for every address, without a lookup", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMTP_HOST", "");
    vi.stubEnv("SMTP_FROM", "");

    const known = await forgotPasswordAction(undefined, form({ email: "bob@zendor.dev" }));
    const unknown = await forgotPasswordAction(undefined, form({ email: "nobody@zendor.dev" }));

    expect(known.error).toEqual(expect.any(String));
    expect(unknown).toEqual(known);
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("with SMTP configured, sends the link and returns the generic success", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMTP_HOST", "smtp.example");
    vi.stubEnv("SMTP_FROM", "noreply@example");
    db.user.findUnique.mockResolvedValue({ id: "u1", passwordHash: "x" });
    db.$transaction.mockResolvedValue([]);

    const result = await forgotPasswordAction(undefined, form({ email: "bob@zendor.dev" }));

    expect(result.success).toEqual(expect.any(String));
    expect(sendMail).toHaveBeenCalledOnce();
  });
});

describe("resetPasswordAction (#208, #209)", () => {
  const token = "a".repeat(64);
  const input = form({ token, password: "NewPassw0rd!", confirmPassword: "NewPassw0rd!" });

  it("refuses a token another request already claimed", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        passwordResetToken: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), deleteMany: vi.fn() },
        user: { update: vi.fn() },
      }),
    );

    const result = await resetPasswordAction(undefined, input);
    expect(result?.error).toEqual(expect.any(String));
    expect(db.passwordResetToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashResetToken(token) },
    });
  });

  it("bumps the session version and redirects to login on success", async () => {
    db.passwordResetToken.findUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const userUpdate = vi.fn();
    const revokeKeys = vi.fn().mockResolvedValue({ count: 1 });
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        passwordResetToken: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), deleteMany: vi.fn() },
        user: { update: userUpdate },
        agentApiKey: { updateMany: revokeKeys },
      }),
    );

    await expect(resetPasswordAction(undefined, input)).rejects.toMatchObject({ to: "/login" });
    expect(userUpdate.mock.calls[0][0].data.sessionVersion).toEqual({ increment: 1 });
    expect(revokeKeys).toHaveBeenCalledWith({
      where: { revokedAt: null, agent: { ownerUserId: "u1" } },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

describe("auth rate limiting and enumeration (#207)", () => {
  it("blocks a fourth reset request for the same email", async () => {
    vi.stubEnv("NODE_ENV", "development");
    db.user.findUnique.mockResolvedValue(null);
    for (let i = 0; i < 3; i++) {
      const ok = await forgotPasswordAction(undefined, form({ email: "bob@zendor.dev" }));
      expect(ok.success).toBeDefined();
    }
    const blocked = await forgotPasswordAction(undefined, form({ email: "bob@zendor.dev" }));
    expect(blocked.error).toEqual(expect.any(String));
  });

  it("doesn't confirm that an email already has an account", async () => {
    const { Prisma } = await import("@prisma/client");
    db.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint", { code: "P2002", clientVersion: "6" }),
    );
    const result = await signupAction(
      undefined,
      form({ name: "Bob", email: "bob@zendor.dev", password: "Passw0rd!234", confirmPassword: "Passw0rd!234" }),
    );
    expect(result?.error).not.toMatch(/already exists/);
    expect(result?.error).toEqual(expect.any(String));
  });
});
