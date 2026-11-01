"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import { currentTenantIdFor } from "@/lib/tenant-context";
import { giveIdeaVerdict, ideaVerdictSchema, withdrawIdea } from "@/lib/agent-api/idea-verdicts";
import { IssueApiError } from "@/lib/agent-api/errors";
import { ACTION_RATE_LIMITS, consumeRateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";

export type IdeaVerdictActionResult = {
  ok?: true;
  error?: string;
  /** True when this replaced the person's earlier verdict. */
  replaced?: boolean;
  ideaScore?: number;
  ideaThreshold?: number;
};

/**
 * A person gives an idea their verdict from the web app (#idea-verdicts):
 * good, bad or neutral, a summary of two sentences at most, and a full description.
 * Always one vote. A newer verdict replaces their earlier one.
 */
export async function giveIdeaVerdictAction(
  ideaId: string,
  formData: FormData,
): Promise<IdeaVerdictActionResult> {
  const user = await requireUser();
  const userId = user.id;

  const limit = await consumeRateLimit(`idea-verdict:${userId}`, ACTION_RATE_LIMITS.addComment);
  if (!limit.allowed) return { error: RATE_LIMIT_MESSAGE };

  const tenantId = await currentTenantIdFor(userId);
  if (!tenantId || typeof ideaId !== "string" || !ideaId) return { error: "Idea not found" };

  const idea = await prisma.idea.findFirst({
    where: { id: ideaId, tenantId, isDeleted: false },
    select: { id: true, number: true, projectId: true },
  });
  if (!idea) return { error: "Idea not found" };

  const parsed = ideaVerdictSchema.safeParse({
    opinion: formData.get("opinion") ?? undefined,
    summary: formData.get("summary") ?? "",
    description: formData.get("description") ?? "",
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === "opinion") return { error: "Pick good, bad or neutral." };
    return { error: issue?.message ?? "Check your verdict and try again." };
  }

  try {
    const given = await giveIdeaVerdict({ tenantId, userId }, idea.projectId, idea.id, parsed.data);
    revalidatePath("/[project]", "layout");
    return { ok: true, replaced: given.replaced, ideaScore: given.ideaScore, ideaThreshold: given.ideaThreshold };
  } catch (error) {
    if (error instanceof IssueApiError) return { error: error.message };
    console.error("[idea-verdict] failed", error);
    return { error: "Could not save your verdict. Please try again." };
  }
}

/**
 * The idea's owner withdraws their own open idea from its page
 * (#idea-withdraw): the same core as `POST /api/v1/ideas/{id}/withdraw`, so
 * only the owner may and only while it is open. It is archived with reason
 * `withdrawn`. Returns an error message, or nothing when it worked.
 */
export async function withdrawIdeaFromPage(ideaId: string): Promise<{ ok?: true; error?: string }> {
  const user = await requireUser();
  const userId = user.id;
  const limit = await consumeRateLimit(`idea-withdraw:${userId}`, ACTION_RATE_LIMITS.addComment);
  if (!limit.allowed) return { error: RATE_LIMIT_MESSAGE };

  const tenantId = await currentTenantIdFor(userId);
  if (!tenantId || typeof ideaId !== "string" || !ideaId) return { error: "Idea not found" };
  const idea = await prisma.idea.findFirst({
    where: { id: ideaId, tenantId, isDeleted: false },
    select: { id: true, number: true, projectId: true },
  });
  if (!idea) return { error: "Idea not found" };

  try {
    await withdrawIdea({ tenantId, userId, agentId: null }, idea.projectId, idea.id);
    revalidatePath("/[project]", "layout");
    return { ok: true };
  } catch (error) {
    if (error instanceof IssueApiError) return { error: error.message };
    console.error("[idea-withdraw] failed", error);
    return { error: "Could not withdraw the idea. Please try again." };
  }
}

/** The idea page's Withdraw form posts here, with the idea's id in `ideaId`. */
export async function withdrawIdeaAction(formData: FormData): Promise<void> {
  const ideaId = formData.get("ideaId");
  await withdrawIdeaFromPage(typeof ideaId === "string" ? ideaId : "");
}
