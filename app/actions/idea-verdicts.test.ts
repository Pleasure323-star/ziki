import { beforeEach, describe, expect, it, vi } from "vitest";

const giveIdeaVerdict = vi.hoisted(() => vi.fn());
const findFirst = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({ revalidatePath, revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));
vi.mock("@/lib/auth-helpers", () => ({ requireUser: vi.fn(async () => ({ id: "ada", role: "user" })) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  consumeRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/tenant-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-context")>()),
  currentTenantIdFor: vi.fn(async () => "tenant-1"),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { idea: { findFirst } } }));
vi.mock("@/lib/agent-api/idea-verdicts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-api/idea-verdicts")>()),
  giveIdeaVerdict,
}));

import { IssueApiError } from "@/lib/agent-api/errors";
import { giveIdeaVerdictAction } from "./idea-verdicts";

function form(values: Record<string, string> = {}) {
  const data = new FormData();
  const merged = { opinion: "good", summary: "Useful for new users.", description: "I hit this every week.", ...values };
  for (const [key, value] of Object.entries(merged)) data.set(key, value);
  return data;
}

describe("giveIdeaVerdictAction (#idea-verdicts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findFirst.mockResolvedValue({ id: "idea-1", number: 7, projectId: "project-1" });
    giveIdeaVerdict.mockResolvedValue({ replaced: false, ideaScore: 1, ideaThreshold: 3 });
  });

  it("gives the verdict as the person, with one vote, in their tenant", async () => {
    expect(await giveIdeaVerdictAction("idea-1", form())).toEqual({ ok: true, replaced: false, ideaScore: 1, ideaThreshold: 3 });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "idea-1", tenantId: "tenant-1", isDeleted: false } }));
    expect(giveIdeaVerdict).toHaveBeenCalledWith({ tenantId: "tenant-1", userId: "ada" }, "project-1", "idea-1", {
      opinion: "good",
      summary: "Useful for new users.",
      description: "I hit this every week.",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/issues");
    expect(revalidatePath).toHaveBeenCalledWith("/ideas/7");
  });

  it("refuses an idea outside the tenant or deleted", async () => {
    findFirst.mockResolvedValue(null);
    expect(await giveIdeaVerdictAction("idea-1", form())).toEqual({ error: expect.any(String) });
    expect(giveIdeaVerdict).not.toHaveBeenCalled();
  });

  it("asks for an opinion, a short summary and a description", async () => {
    expect(await giveIdeaVerdictAction("idea-1", form({ opinion: "great" }))).toEqual({ error: expect.any(String) });
    expect(await giveIdeaVerdictAction("idea-1", form({ summary: "One. Two. Three." }))).toEqual({
      error: expect.any(String),
    });
    expect(await giveIdeaVerdictAction("idea-1", form({ description: "  " }))).toEqual({
      error: expect.any(String),
    });
    expect(giveIdeaVerdict).not.toHaveBeenCalled();
  });

  it("ignores a votes field: a person always gives one vote", async () => {
    await giveIdeaVerdictAction("idea-1", form({ votes: "5" }));
    expect(giveIdeaVerdict.mock.calls[0][3]).not.toHaveProperty("votes");
  });

  it("shows the API's refusal, such as on a closed idea", async () => {
    giveIdeaVerdict.mockRejectedValue(new IssueApiError(409, "This idea is no longer open.", { error: "idea_converted" }));
    expect(await giveIdeaVerdictAction("idea-1", form())).toEqual({ error: "This idea is no longer open." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("hides unexpected errors behind a retry message", async () => {
    giveIdeaVerdict.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await giveIdeaVerdictAction("idea-1", form())).toEqual({ error: expect.any(String) });
  });
});
