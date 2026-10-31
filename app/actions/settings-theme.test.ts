import { describe, expect, it, vi } from "vitest";

const requireUser = vi.hoisted(() => vi.fn());
const cookieSet = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: cookieSet }) }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { update: vi.fn() } } }));

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { setThemeAction } from "./settings";

describe("setThemeAction (#277)", () => {
  it("saves the choice on the account and in this device's cookie", async () => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "u1", role: "user" });
    expect(await setThemeAction("dark")).toEqual({ ok: true });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { theme: "dark" } });
    expect(cookieSet).toHaveBeenCalledWith("theme", "dark", expect.objectContaining({ path: "/", httpOnly: true }));
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("rejects anything but system, light or dark", async () => {
    vi.clearAllMocks();
    expect(await setThemeAction("purple")).toEqual({ error: expect.any(String) });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("reports a failed account save instead of claiming success (#646)", async () => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "u1", role: "user" });
    vi.mocked(prisma.user.update).mockRejectedValueOnce(new Error("database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(setThemeAction("dark")).resolves.toEqual({
      error: expect.any(String),
    });
    // The caller reverts the optimistic switch, so this device keeps the saved
    // preference too: don't leave a cookie that disagrees with the account.
    expect(cookieSet).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
