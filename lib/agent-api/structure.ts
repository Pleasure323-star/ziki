import { prisma } from "@/lib/prisma";
import type { AgentContext } from "@/lib/agents/require-agent";
import { IssueApiError, readAgentIssue } from "@/lib/agent-api/issues";
import { findSimilarIssues } from "@/lib/agent-api/create-policy";
import type { SimilarIssue } from "@/lib/similar-issues";
import { audit } from "@/lib/agents/audit";
import { publish } from "@/lib/agent-api/events";
import { reviewerConflict, ReviewerNotIndependentError } from "@/lib/agents/independence";
import { z } from "zod";

const idSchema = z.string().trim().min(1).max(191);

export const structureInputSchema = z
  .object({
    projectId: idSchema.optional(),
    title: z.string().trim().min(3).max(200).optional(),
    stepsToReproduce: z.string().trim().optional(),
    expectedBehavior: z.string().trim().optional(),
    actualBehavior: z.string().trim().optional(),
    environment: z.string().trim().optional(),
    description: z.string().trim().max(5000).optional(),
    platform: z.string().trim().optional(),
    categoryId: idSchema.optional(),
    type: z.string().trim().optional(),
    typeId: idSchema.optional(),
    duplicateOfId: idSchema.optional(),
    checkDuplicates: z.boolean().optional().default(true),
  })
  .strict();

export type StructureInput = z.infer<typeof structureInputSchema>;

/**
 * Heuristic platform inference matching text against available category names.
 */
export function inferPlatform(
  text: string,
  categories: { id: string; name: string }[],
): string | null {
  const lower = text.toLowerCase();

  // Keyword mappings
  const platformKeywords: Record<string, string[]> = {
    mobile: ["mobile", "ios", "iphone", "ipad", "android", "apk"],
    web: ["web", "browser", "chrome", "firefox", "safari", "edge", "website", "frontend"],
    desktop: ["desktop", "macos", "mac", "windows", "linux", "electron"],
  };

  for (const cat of categories) {
    const catNameLower = cat.name.toLowerCase();
    // Direct name match
    if (lower.includes(catNameLower)) return cat.id;

    // Check keyword groups
    for (const [group, keywords] of Object.entries(platformKeywords)) {
      if (catNameLower.includes(group)) {
        if (keywords.some((kw) => lower.includes(kw))) {
          return cat.id;
        }
      }
    }
  }

  return null;
}

/**
 * Heuristic issue type inference matching text against available types.
 */
export function inferType(
  text: string,
  types: { id: string; name: string }[],
): string | null {
  const lower = text.toLowerCase();

  const typeKeywords: Record<string, string[]> = {
    feature: ["feature", "request", "suggest", "enhancement", "add support", "would be nice"],
    bug: ["bug", "crash", "fails", "broken", "error", "exception", "freeze", "hang", "regression"],
    fix: ["fix", "patch", "repair"],
  };

  for (const t of types) {
    const typeNameLower = t.name.toLowerCase();
    if (lower.includes(typeNameLower)) return t.id;

    for (const [group, keywords] of Object.entries(typeKeywords)) {
      if (typeNameLower.includes(group)) {
        if (keywords.some((kw) => lower.includes(kw))) {
          return t.id;
        }
      }
    }
  }

  return null;
}

/**
 * Formulates a structured description markdown from discrete components.
 */
export function formatStructuredDescription(parts: {
  stepsToReproduce?: string;
  expectedBehavior?: string;
  actualBehavior?: string;
  environment?: string;
  rawDescription?: string;
}): string {
  const sections: string[] = [];

  if (parts.stepsToReproduce?.trim()) {
    sections.push(`### Steps to Reproduce\n${parts.stepsToReproduce.trim()}`);
  }
  if (parts.expectedBehavior?.trim()) {
    sections.push(`### Expected Behavior\n${parts.expectedBehavior.trim()}`);
  }
  if (parts.actualBehavior?.trim()) {
    sections.push(`### Actual Behavior\n${parts.actualBehavior.trim()}`);
  }
  if (parts.environment?.trim()) {
    sections.push(`### Environment\n${parts.environment.trim()}`);
  }

  if (sections.length > 0) {
    return sections.join("\n\n");
  }

  return parts.rawDescription?.trim() || "";
}

export type StructureResult = {
  ok: boolean;
  issue: Awaited<ReturnType<typeof readAgentIssue>>;
  structured: boolean;
  potentialDuplicates: SimilarIssue[];
  inferred: {
    categoryId: string | null;
    typeId: string | null;
  };
};

/**
 * Processes an incoming report: checks duplicates, infers metadata, formats
 * structured description and logs activity. Marking a duplicate here sets
 * `duplicateOfId` on the issue; it is not a confirmation entry.
 */
export async function structureIssue(
  agent: AgentContext,
  projectId: string,
  bugId: string,
  rawInput: unknown,
): Promise<StructureResult> {
  const input = structureInputSchema.parse(rawInput ?? {});

  const bug = await prisma.bug.findFirst({
    where: { id: bugId, tenantId: agent.tenantId, projectId, isDeleted: false },
    select: {
      id: true,
      title: true,
      description: true,
      projectId: true,
      tenantId: true,
      categoryId: true,
      typeId: true,
      duplicateOfId: true,
      status: true,
      reporterId: true,
      beneficiaryUserId: true,
      assigneeId: true,
      createdByAgent: { select: { ownerUserId: true } },
      claims: { where: { status: "active", releasedAt: null }, select: { status: true, releasedAt: true, beneficiaryUserId: true, dispatcherUserId: true, agent: { select: { ownerUserId: true } } } },
    },
  });

  if (!bug) {
    throw new IssueApiError(404, "Issue not found in this project.");
  }

  const conflict = reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, bug);
  if (input.duplicateOfId) {
    if (conflict) throw new IssueApiError(403, new ReviewerNotIndependentError(conflict).message);
  }

  const queryTitle = input.title || bug.title;
  let potentialDuplicates: SimilarIssue[] = [];

  if (input.checkDuplicates) {
    potentialDuplicates = await findSimilarIssues(
      prisma,
      { tenantId: agent.tenantId, projectId },
      queryTitle,
    );
    // Exclude self from duplicates list
    potentialDuplicates = potentialDuplicates.filter((m) => m.id !== bug.id);
  }

  // Load available platforms and types
  const [categories, types] = await Promise.all([
    prisma.category.findMany({
      where: { tenantId: agent.tenantId, isActive: true },
      select: { id: true, name: true },
    }),
    prisma.issueType.findMany({
      where: { tenantId: agent.tenantId, isActive: true },
      select: { id: true, name: true },
    }),
  ]);

  const fullText = `${queryTitle} ${input.description || bug.description} ${input.actualBehavior || ""} ${input.stepsToReproduce || ""}`;

  // Resolve category / platform
  let resolvedCategoryId = bug.categoryId;
  if (input.categoryId) {
    const matched = categories.find((c) => c.id === input.categoryId);
    if (!matched) throw new IssueApiError(422, "Invalid platform categoryId.");
    resolvedCategoryId = matched.id;
  } else if (input.platform) {
    const matched = categories.find((c) => c.name.toLowerCase() === input.platform?.toLowerCase());
    resolvedCategoryId = matched ? matched.id : inferPlatform(input.platform, categories);
  } else if (!resolvedCategoryId) {
    resolvedCategoryId = inferPlatform(fullText, categories);
  }

  // Resolve type
  let resolvedTypeId = bug.typeId;
  if (input.typeId) {
    const matched = types.find((t) => t.id === input.typeId);
    if (!matched) throw new IssueApiError(422, "Invalid issue typeId.");
    resolvedTypeId = matched.id;
  } else if (input.type) {
    const matched = types.find((t) => t.name.toLowerCase() === input.type?.toLowerCase());
    resolvedTypeId = matched ? matched.id : inferType(input.type, types);
  } else if (!resolvedTypeId) {
    resolvedTypeId = inferType(fullText, types);
  }

  // Structured description
  let structuredDesc = input.description?.trim();
  if (!structuredDesc) {
    if (input.stepsToReproduce || input.expectedBehavior || input.actualBehavior || input.environment) {
      structuredDesc = formatStructuredDescription({
        stepsToReproduce: input.stepsToReproduce,
        expectedBehavior: input.expectedBehavior,
        actualBehavior: input.actualBehavior,
        environment: input.environment,
        rawDescription: bug.description,
      });
    } else {
      structuredDesc = bug.description;
    }
  }

  // Duplicate resolution
  let resolvedDuplicateOfId = bug.duplicateOfId;
  if (input.duplicateOfId) {
    const canonical = await prisma.bug.findFirst({
      where: { id: input.duplicateOfId, tenantId: agent.tenantId, projectId, isDeleted: false },
      select: { id: true },
    });
    if (!canonical) throw new IssueApiError(422, "Canonical duplicate issue not found in this project.");
    if (canonical.id === bug.id) throw new IssueApiError(422, "An issue cannot be a duplicate of itself.");
    resolvedDuplicateOfId = canonical.id;
  }

  await prisma.$transaction(async (tx) => {
    await tx.bug.update({
      where: { id: bug.id },
      data: {
        title: queryTitle,
        description: structuredDesc,
        categoryId: resolvedCategoryId,
        typeId: resolvedTypeId,
        duplicateOfId: resolvedDuplicateOfId,
        updatedAt: new Date(),
      },
    });

    // Activity log
    await tx.bugActivity.create({
      data: {
        bugId: bug.id,
        actorId: agent.ownerId,
        type: "edited",
        summary: "Agent structured issue from report",
      },
    });

    // Emit event
    await publish(tx, {
      tenantId: agent.tenantId,
      type: "issue.structured",
      payload: {
        issueId: bug.id,
        projectId,
        structuredByAgentId: agent.agentId,
        categoryId: resolvedCategoryId,
        typeId: resolvedTypeId,
        duplicateOfId: resolvedDuplicateOfId,
      },
      actorAgentId: agent.agentId,
      bugId: bug.id,
    });

    await audit(agent, "issue.structured", bug.id, {
      categoryId: resolvedCategoryId,
      typeId: resolvedTypeId,
      duplicateOfId: resolvedDuplicateOfId,
    }, { db: tx, bugId: bug.id });
  });

  const updatedIssue = await readAgentIssue({ tenantId: agent.tenantId, projectId }, bug.id);

  return {
    ok: true,
    issue: updatedIssue,
    structured: true,
    potentialDuplicates,
    inferred: {
      categoryId: resolvedCategoryId,
      typeId: resolvedTypeId,
    },
  };
}
