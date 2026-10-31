import { beforeEach, describe, expect, it, vi } from "vitest";

/** #1059: downvotes were removed, so the action refuses -1 outright. */

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: vi.fn(async () => ({ userId: "ada" })),
  SESSION_EXPIRED_MESSAGE: "Session expired",
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bug: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "@/lib/prisma";
import { DOWNVOTES_REMOVED_MESSAGE } from "@/lib/voting";
import { toggleVoteAction } from "./issues";

describe("toggleVoteAction without downvotes (#1059)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses a downvote before touching the issue or its votes", async () => {
    expect(await toggleVoteAction("bug-1", -1)).toEqual({ error: DOWNVOTES_REMOVED_MESSAGE });
    expect(prisma.bug.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("still rejects nonsense directions as before", async () => {
    expect(await toggleVoteAction("bug-1", 0)).toEqual({ error: expect.any(String) });
  });
});
