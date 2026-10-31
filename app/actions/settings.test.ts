import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { update: vi.fn(), findUnique: vi.fn() } } }));
vi.mock("bcryptjs", () => ({ compare: vi.fn(), hash: vi.fn() }));
vi.mock("@/lib/mail", () => ({ smtpConfigured: vi.fn(), sendMail: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  RATE_LIMIT_MESSAGE: "You're doing that too fast. Please wait a moment.",
  consumeAuthRateLimit: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { compare, hash } from "bcryptjs";
import { smtpConfigured, sendMail } from "@/lib/mail";
import { consumeAuthRateLimit } from "@/lib/rate-limit";
import { changePasswordAction, setKeyboardShortcutsAction, setWalletAddressAction, updateDisplayNameAction } from "./settings";

const update = prisma.user.update as unknown as ReturnType<typeof vi.fn>;
const findUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;
// bcryptjs's callback overloads make vi.mocked() expect a void return.
const compareMock = compare as unknown as ReturnType<typeof vi.fn>;
const hashMock = hash as unknown as ReturnType<typeof vi.fn>;
const form = (name: string) => {
  const f = new FormData();
  f.set("name", name);
  return f;
};

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "u1", role: "user" });
  vi.mocked(consumeAuthRateLimit).mockResolvedValue({ allowed: true, retryAfterMs: 0 });
  vi.mocked(smtpConfigured).mockReturnValue(false);
});

describe("updateDisplayNameAction (#293)", () => {
  it("saves the trimmed name for the signed-in user only, and nothing else", async () => {
    const result = await updateDisplayNameAction(undefined, form("  Ada   Lovelace "));
    expect(result).toEqual({ ok: true, name: "Ada Lovelace" });
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { name: "Ada Lovelace" } });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("ignores any id, email or role smuggled into the form", async () => {
    const f = form("Ada Lovelace");
    f.set("id", "someone-else");
    f.set("email", "x@y.z");
    f.set("role", "super_admin");
    await updateDisplayNameAction(undefined, f);
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { name: "Ada Lovelace" } });
  });

  it.each(["", "   ", "A", "​​", "Sam (Admin)"])(
    "rejects %j and names the field",
    async (name) => {
      const result = await updateDisplayNameAction(undefined, form(name));
      expect(result.ok).toBeUndefined();
      expect(result.field).toBe("name");
      expect(result.fieldErrors?.name).toBeTruthy();
      expect(update).not.toHaveBeenCalled();
    },
  );

  it("lets an admin use the word", async () => {
    requireUser.mockResolvedValue({ id: "a1", role: "admin" });
    const result = await updateDisplayNameAction(undefined, form("Sam (Admin)"));
    expect(result.ok).toBe(true);
  });

  it("treats a missing field as blank", async () => {
    const result = await updateDisplayNameAction(undefined, new FormData());
    expect(result.field).toBe("name");
  });
});

describe("setKeyboardShortcutsAction (#287)", () => {
  it("saves the switch for the signed-in user and refreshes every page", async () => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "u1", role: "user" });
    expect(await setKeyboardShortcutsAction(false)).toEqual({ ok: true });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { keyboardShortcuts: false } });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("rejects anything but a boolean", async () => {
    vi.clearAllMocks();
    expect(await setKeyboardShortcutsAction("off")).toEqual({ error: expect.any(String) });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("setWalletAddressAction (#618)", () => {
  const walletForm = (value: string | null) => {
    const f = new FormData();
    if (value !== null) f.set("walletAddress", value);
    return f;
  };
  const address = `0x${"a".repeat(40)}`;

  it("saves the trimmed address on the signed-in person's own row", async () => {
    const result = await setWalletAddressAction(undefined, walletForm(`  ${address}  `));
    expect(result).toEqual({ ok: true, walletAddress: address });
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { walletAddress: address } });
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("ignores any id smuggled into the form, so nobody can set a wallet for someone else", async () => {
    const f = walletForm(address);
    f.set("id", "someone-else");
    await setWalletAddressAction(undefined, f);
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { walletAddress: address } });
  });

  it("clears the address when the field is left empty", async () => {
    expect(await setWalletAddressAction(undefined, walletForm(""))).toEqual({
      ok: true,
      walletAddress: null,
    });
    expect(update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { walletAddress: null } });
  });

  it.each([
    ["a truncated address", "0xdeadbeef"],
    ["a missing 0x prefix", `0${"a".repeat(40)}`],
    ["non-hex characters", `0x${"g".repeat(40)}`],
    ["a domain instead of an address", "vitalik.eth"],
  ])("rejects %s and writes nothing", async (_label, value) => {
    const result = await setWalletAddressAction(undefined, walletForm(value));
    expect(result.ok).toBeUndefined();
    expect(result.field).toBe("walletAddress");
    expect(result.error).toEqual(expect.any(String));
    expect(update).not.toHaveBeenCalled();
  });
});

describe("changePasswordAction (#570)", () => {
  const passwordForm = (currentPassword = "OldPassw0rd!", password = "NewPassw0rd!") => {
    const f = new FormData();
    f.set("currentPassword", currentPassword);
    f.set("password", password);
    f.set("confirmPassword", password);
    return f;
  };

  it("updates only the signed-in user's password and invalidates every session", async () => {
    findUnique.mockResolvedValue({ email: "ada@example.com", passwordHash: "old-hash" });
    compareMock.mockResolvedValue(true);
    hashMock.mockResolvedValue("new-hash");

    await expect(changePasswordAction(undefined, passwordForm())).resolves.toEqual({ ok: true });

    expect(consumeAuthRateLimit).toHaveBeenCalledWith("changePassword", { email: "user:u1", ip: null });
    expect(update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { passwordHash: "new-hash", sessionVersion: { increment: 1 } },
    });
  });

  it("rejects an incorrect current password without changing it", async () => {
    findUnique.mockResolvedValue({ email: "ada@example.com", passwordHash: "old-hash" });
    compareMock.mockResolvedValue(false);

    await expect(changePasswordAction(undefined, passwordForm("wrong password"))).resolves.toMatchObject({
      field: "currentPassword",
      error: expect.stringMatching(/incorrect/),
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("does not check credentials or update when password-change attempts are rate limited", async () => {
    vi.mocked(consumeAuthRateLimit).mockResolvedValue({ allowed: false, retryAfterMs: 1000 });

    await expect(changePasswordAction(undefined, passwordForm())).resolves.toEqual({
      error: "You're doing that too fast. Please wait a moment.",
    });
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("sends a security notice when mail is available, without delaying the password change", async () => {
    findUnique.mockResolvedValue({ email: "ada@example.com", passwordHash: "old-hash" });
    compareMock.mockResolvedValue(true);
    hashMock.mockResolvedValue("new-hash");
    vi.mocked(smtpConfigured).mockReturnValue(true);
    vi.mocked(sendMail).mockResolvedValue(undefined);

    await changePasswordAction(undefined, passwordForm());
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: "ada@example.com",
      subject: "Your Ziki Issues password was changed",
    }));
  });
});
