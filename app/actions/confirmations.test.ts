import { beforeEach, describe, expect, it, vi } from "vitest";

const giveConfirmation = vi.hoisted(() => vi.fn());
const findFirst = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({ revalidatePath, revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: vi.fn(async () => ({ id: "bob", role: "user" })) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  consumeRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor: vi.fn(async () => "tenant-1"),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { bug: { findFirst } } }));
vi.mock("@/lib/agent-api/confirmations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-api/confirmations")>()),
  giveConfirmation,
}));

import { IssueApiError } from "@/lib/agent-api/errors";
import { giveConfirmationAction } from "./confirmations";

function form(values: Record<string, string> = {}) {
  const data = new FormData();
  const merged = { verdict: "confirm", summary: "Reproduced it.", description: "Followed the steps on Chrome.", ...values };
  for (const [key, value] of Object.entries(merged)) data.set(key, value);
  return data;
}

describe("giveConfirmationAction (#issue-confirmations)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findFirst.mockResolvedValue({ id: "bug-1", number: 7, projectId: "project-1" });
    giveConfirmation.mockResolvedValue({ replaced: false, confirmed: false, confirmations: 1, confirmationsNeeded: 2 });
  });

  it("gives the entry as the person, in their tenant, and sends no severity", async () => {
    expect(await giveConfirmationAction("bug-1", form({ severity: "high" }))).toEqual({
      ok: true,
      replaced: false,
      confirmed: false,
      confirmations: 1,
      confirmationsNeeded: 2,
    });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "bug-1", tenantId: "tenant-1", isDeleted: false } }));
    expect(giveConfirmation).toHaveBeenCalledWith(
      { tenantId: "tenant-1", userId: "bob" },
      { tenantId: "tenant-1", projectId: "project-1" },
      "bug-1",
      { verdict: "confirm", summary: "Reproduced it.", description: "Followed the steps on Chrome." },
    );
    expect(revalidatePath).toHaveBeenCalledWith("/issues");
    expect(revalidatePath).toHaveBeenCalledWith("/issues/7");
  });

  it("sends the duplicate only with reject, and drops fields the verdict doesn't take", async () => {
    await giveConfirmationAction("bug-1", form({ verdict: "reject", duplicateOfId: "3", severity: "high" }));
    expect(giveConfirmation.mock.calls[0][3]).toEqual({ verdict: "reject", summary: "Reproduced it.", description: "Followed the steps on Chrome.", duplicateOfId: "3" });
    await giveConfirmationAction("bug-1", form({ verdict: "neutral", duplicateOfId: "3" }));
    expect(giveConfirmation.mock.calls[1][3]).not.toHaveProperty("duplicateOfId");
  });

  it("refuses an issue outside the tenant or deleted", async () => {
    findFirst.mockResolvedValue(null);
    expect(await giveConfirmationAction("bug-1", form())).toEqual({ error: "Issue not found" });
    expect(giveConfirmation).not.toHaveBeenCalled();
  });

  it("asks for a verdict, a short summary and a description: no bare verdicts", async () => {
    expect(await giveConfirmationAction("bug-1", form({ verdict: "maybe" }))).toEqual({ error: "Pick confirm, reject or neutral." });
    expect(await giveConfirmationAction("bug-1", form({ summary: "One. Two. Three." }))).toEqual({ error: "Keep the summary to two sentences." });
    expect(await giveConfirmationAction("bug-1", form({ description: "  " }))).toEqual({ error: "Add a description explaining your verdict." });
    expect(giveConfirmation).not.toHaveBeenCalled();
  });

  it("passes on the service's refusal, such as confirming your own issue", async () => {
    giveConfirmation.mockRejectedValue(new IssueApiError(403, "This is your own issue (you reported it or it is for you), so you can't confirm it."));
    expect(await giveConfirmationAction("bug-1", form())).toEqual({
      error: "This is your own issue (you reported it or it is for you), so you can't confirm it.",
    });
  });
});
