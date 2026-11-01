import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two-factor sign-in (#648): the login asks for a code when the account has
 * it on, a code works once inside its window, backup codes are spent once,
 * and guessing is rate limited.
 */
const db = vi.hoisted(() => ({
  totpCredential: { findUnique: vi.fn(), updateMany: vi.fn() },
  totpBackupCode: { updateMany: vi.fn() },
  securityAuditEvent: { create: vi.fn() },
}));
const limits = vi.hoisted(() => ({ attempt: vi.fn(), auth: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn(async () => new Headers()) }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  }),
}));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  consumeRateLimit: limits.attempt,
  consumeAuthRateLimit: limits.auth,
}));
vi.mock("@/lib/auth-mode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-mode")>()),
  isPasswordAuthEnabled: () => true,
}));

import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { loginAction } from "@/app/actions/auth";
import { sealSecret } from "@/lib/secret-box";
import { base32Encode, matchTotp, totpCode, totpStep } from "@/lib/totp";
import { hashBackupCode, verifySecondFactor } from "@/lib/two-factor";

const signInMock = vi.mocked(signIn);
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const NOW = 1_800_000_000_000;
const STEP = totpStep(NOW);
const goodCode = () => totpCode(SECRET, STEP);

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}
const authError = (code: string) => Object.assign(new AuthError("sign in failed"), { code });
const enabled = (lastUsedStep: number | null = null) =>
  db.totpCredential.findUnique.mockResolvedValue({ userId: "u1", secret: sealSecret(SECRET), enabledAt: new Date(), lastUsedStep });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = "test-secret-that-is-long-enough-for-hashing";
  limits.attempt.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
  limits.auth.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
});

describe("the login's second step", () => {
  it("asks for a code when the password was right and two-factor is on, and passes the typed code on", async () => {
    signInMock.mockRejectedValueOnce(authError("two_factor_required"));
    expect(await loginAction(undefined, form({ email: "a@b.co", password: "pw" }))).toEqual({ error: expect.any(String), needsCode: true });

    signInMock.mockResolvedValueOnce(undefined as never);
    await expect(loginAction(undefined, form({ email: "a@b.co", password: "pw", totp: "123456", callbackUrl: "/issues" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(signInMock).toHaveBeenLastCalledWith("credentials", { email: "a@b.co", password: "pw", totp: "123456", redirect: false });
  });

  it("keeps asking after a wrong code, and gives one generic message for a bad password", async () => {
    signInMock.mockRejectedValueOnce(authError("two_factor_invalid"));
    expect((await loginAction(undefined, form({ email: "a@b.co", password: "pw", totp: "000000" })))?.needsCode).toBe(true);
    signInMock.mockRejectedValueOnce(authError("credentials"));
    const bad = await loginAction(undefined, form({ email: "a@b.co", password: "wrong" }));
    expect(bad).toEqual({ error: expect.any(String), field: "email" });
  });
});

describe("verifying the code", () => {
  it("accepts a right code once, moving the used step forward atomically", async () => {
    enabled();
    db.totpCredential.updateMany.mockResolvedValue({ count: 1 });
    expect(await verifySecondFactor("u1", goodCode(), NOW)).toBe("totp");
    expect(db.totpCredential.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: STEP } }] },
      data: { lastUsedStep: STEP },
    });
  });

  it("rejects a replayed step, a lost race and a wrong code", async () => {
    enabled(STEP);
    expect(await verifySecondFactor("u1", goodCode(), NOW)).toBeNull();
    enabled();
    db.totpCredential.updateMany.mockResolvedValue({ count: 0 });
    expect(await verifySecondFactor("u1", goodCode(), NOW)).toBeNull();
    expect(await verifySecondFactor("u1", "123456", NOW)).toBeNull();
  });

  it("spends a backup code once and audits it", async () => {
    enabled();
    db.totpBackupCode.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await verifySecondFactor("u1", "abcde-fghjk", NOW)).toBe("backup");
    expect(db.totpBackupCode.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", codeHash: hashBackupCode("u1", "ABCDEFGHJK"), usedAt: null },
      data: { usedAt: new Date(NOW) },
    });
    expect(db.securityAuditEvent.create).toHaveBeenCalledWith({ data: { userId: "u1", type: "totp.backup_code_used" } });
    expect(await verifySecondFactor("u1", "ABCDE-FGHJK", NOW)).toBeNull();
  });

  it("is rate limited, so a six-digit code can't be guessed", async () => {
    limits.attempt.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    enabled();
    expect(await verifySecondFactor("u1", goodCode(), NOW)).toBeNull();
    expect(db.totpCredential.findUnique).not.toHaveBeenCalled();
  });

  it("allows one step of clock drift and nothing wider (RFC 6238)", () => {
    const rfc = base32Encode(Buffer.from("12345678901234567890"));
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    expect(matchTotp(rfc, totpCode(rfc, step - 1), { nowMs: now })).toBe(step - 1);
    expect(matchTotp(rfc, totpCode(rfc, step + 2), { nowMs: now })).toBeNull();
  });
});
