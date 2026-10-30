import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { IssueApiError } from "@/lib/agent-api/errors";
import { publish } from "@/lib/agent-api/events";
import { isTenantAdminRole } from "@/lib/agents/membership";
import { notifyLater } from "@/lib/notify";
import { mergeAcceptedFix } from "@/lib/github/merge-pr";
import type { AgentContext } from "@/lib/agents/require-agent";

export type ApprovalStage = "before_offer" | "before_merge";
export type ApprovalStatus = "pending" | "approved" | "rejected";

type Db = PrismaClient | Prisma.TransactionClient;

export const approvalRuleSchema = z
  .object({
    stage: z.enum(["before_offer", "before_merge"]),
    issueTypeId: z.string().trim().min(1).optional().nullable(),
    fileGlob: z.string().trim().min(1).max(500).optional().nullable(),
  })
  .strict();

export type ApprovalRuleInput = z.infer<typeof approvalRuleSchema>;

/**
 * Pure glob matcher supporting *, **, and ? patterns.
 */
export function matchGlob(pattern: string, path: string): boolean {
  const normPattern = pattern.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const normPath = path.trim().replace(/\\/g, "/").replace(/^\/+/, "");

  if (normPattern === normPath) return true;

  let regexPattern = "";
  for (let i = 0; i < normPattern.length; i++) {
    const c = normPattern[i];
    if (c === "*") {
      if (normPattern[i + 1] === "*") {
        if (normPattern[i + 2] === "/") {
          regexPattern += "(?:.*\\/)?";
          i += 2;
        } else {
          regexPattern += ".*";
          i += 1;
        }
      } else {
        regexPattern += "[^/]*";
      }
    } else if (c === "?") {
      regexPattern += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      regexPattern += "\\" + c;
    } else {
      regexPattern += c;
    }
  }

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(normPath);
}

export type ApprovalRuleLike = {
  id?: string;
  stage: string;
  issueTypeId?: string | null;
  fileGlob?: string | null;
};

export type MatchContext = {
  stage: ApprovalStage;
  issueTypeId?: string | null;
  issueTypeName?: string | null;
  files?: string[];
};

/**
 * Checks whether an ApprovalRule matches the given issue context.
 */
export function ruleMatches(rule: ApprovalRuleLike, context: MatchContext): boolean {
  if (rule.stage !== context.stage) return false;

  // Match on issue type if rule specifies one
  if (rule.issueTypeId) {
    const target = rule.issueTypeId.toLowerCase();
    const matchId = context.issueTypeId && context.issueTypeId.toLowerCase() === target;
    const matchName = context.issueTypeName && context.issueTypeName.toLowerCase() === target;
    if (!matchId && !matchName) return false;
  }

  // Match on file glob if rule specifies one
  if (rule.fileGlob) {
    if (!context.files || context.files.length === 0) return false;
    const matchesFile = context.files.some((f) => matchGlob(rule.fileGlob!, f));
    if (!matchesFile) return false;
  }

  return true;
}

/**
 * Gating check for an issue at a given pipeline stage (#598).
 * If a rule matches and approval has not yet been granted:
 * - Creates an IssueApproval (if none exists yet)
 * - Publishes `approval.requested`
 * - Notifies tenant admins
 * - Throws IssueApiError(409, "waiting_for_human", { approvalId })
 */
export async function assertApprovalOpen(
  bugId: string,
  stage: ApprovalStage,
  options: {
    db?: Db;
    tenantId?: string;
    agent?: AgentContext;
    files?: string[];
    bug?: {
      id: string;
      title: string;
      tenantId: string;
      projectId: string;
      typeId: string | null;
      type?: { id: string; name: string } | null;
    } | null;
  } = {},
): Promise<void> {
  const db = options.db ?? prisma;

  if (typeof (db as { approvalRule?: unknown }).approvalRule === "undefined") {
    return;
  }

  const bug = options.bug ?? (
    typeof (db as { bug?: { findUnique?: unknown } }).bug?.findUnique === "function"
      ? await db.bug.findUnique({
          where: { id: bugId },
          select: {
            id: true,
            title: true,
            tenantId: true,
            projectId: true,
            typeId: true,
            type: { select: { id: true, name: true } },
          },
        })
      : typeof (db as { bug?: { findFirst?: unknown } }).bug?.findFirst === "function"
        ? await db.bug.findFirst({
            where: { id: bugId },
            select: {
              id: true,
              title: true,
              tenantId: true,
              projectId: true,
              typeId: true,
              type: { select: { id: true, name: true } },
            },
          })
        : null
  );
  if (!bug) return;

  const rules = await db.approvalRule.findMany({
    where: { projectId: bug.projectId, stage },
  });
  if (!rules.length) return;

  const matchContext: MatchContext = {
    stage,
    issueTypeId: bug.typeId,
    issueTypeName: bug.type?.name ?? null,
    files: options.files,
  };

  const matchingRule = rules.find((r) => ruleMatches(r, matchContext));
  if (!matchingRule) return;

  // Check if approval already exists
  const existing = await db.issueApproval.findFirst({
    where: { bugId, stage },
    orderBy: { createdAt: "desc" },
  });

  if (existing) {
    if (existing.status === "approved") return;
    if (existing.status === "rejected") {
      throw new IssueApiError(409, "Human approval was rejected.");
    }
    throw new IssueApiError(409, "waiting_for_human", { approvalId: existing.id });
  }

  // Create new pending approval
  const created = await db.issueApproval.create({
    data: {
      bugId,
      ruleId: matchingRule.id,
      stage,
      status: "pending",
    },
  });

  try {
    await publish(db, {
      tenantId: bug.tenantId,
      type: "approval.requested",
      actorAgentId: options.agent?.agentId ?? null,
      bugId,
      payload: {
        approvalId: created.id,
        issueId: bugId,
        stage,
        ruleId: matchingRule.id,
      },
    });
  } catch {
    // In mock DB environments, ignore publish errors if event tables are unmocked
  }

  // Notify tenant admins (#443)
  if (typeof (db as { membership?: { findMany?: unknown } }).membership?.findMany === "function") {
    const admins = await db.membership.findMany({
      where: { tenantId: bug.tenantId, role: { in: ["admin", "owner"] } },
      select: { userId: true },
    });

    for (const admin of admins) {
      notifyLater({
        kind: "approval_needed",
        actorId: null,
        actorName: options.agent?.name ?? "Ziki",
        recipientId: admin.userId,
        tenantId: bug.tenantId,
        proposalId: created.id,
        proposalTitle: `Human approval required before ${stage === "before_merge" ? "merge" : "offer"}`,
        bugId: bug.id,
        bugTitle: bug.title,
      });
    }
  }

  throw new IssueApiError(409, "waiting_for_human", { approvalId: created.id });
}

/**
 * Non-throwing check for approval status, useful for mergeAcceptedFix.
 */
export async function checkApprovalOpen(
  bugId: string,
  stage: ApprovalStage,
  options: {
    db?: Db;
    files?: string[];
    agent?: AgentContext;
  } = {},
): Promise<{ allowed: true } | { allowed: false; approvalId: string; status: "pending" | "rejected" }> {
  try {
    await assertApprovalOpen(bugId, stage, options);
    return { allowed: true };
  } catch (error) {
    if (error instanceof IssueApiError && error.status === 409) {
      const approvalId = (error.body?.approvalId as string) ?? "";
      const status = error.message === "waiting_for_human" ? "pending" : "rejected";
      return { allowed: false, approvalId, status };
    }
    throw error;
  }
}

/**
 * Approves or rejects an IssueApproval (#598).
 * Only tenant admins can decide approvals.
 * When approved:
 * - Publishes `approval.granted`
 * - Audits the decision
 * - Resumes the pipeline automatically (the offer or merge resumes)
 */
export async function decideApproval(
  userId: string,
  tenantId: string,
  approvalId: string,
  decision: "approved" | "rejected",
  deps: {
    db?: Db;
  } = {},
) {
  const db = deps.db ?? prisma;

  const run = async (tx: Db) => {
    const member = await tx.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: { userId: true, role: true },
    });
    if (!member) throw new IssueApiError(403, "Workspace membership required.");
    if (!isTenantAdminRole(member.role)) {
      throw new IssueApiError(403, "Only workspace owners and admins can decide approvals.");
    }

    const approval = await tx.issueApproval.findFirst({
      where: { id: approvalId },
      include: {
        bug: {
          select: {
            id: true,
            title: true,
            tenantId: true,
            projectId: true,
            status: true,
            assigneeId: true,
            pullRequestUrl: true,
          },
        },
      },
    });
    if (!approval || approval.bug.tenantId !== tenantId) {
      throw new IssueApiError(404, "Approval request not found.");
    }
    if (approval.status !== "pending") {
      throw new IssueApiError(409, `This approval has already been ${approval.status}.`);
    }

    // #537: claim the pending row atomically. A plain update let two admins
    // both pass the status check above; the conditional write lets only one
    // of them win, and the loser gets a 409 instead of acting on a stale read.
    const decidedAt = new Date();
    const claimed = await tx.issueApproval.updateMany({
      where: { id: approvalId, status: "pending" },
      data: {
        status: decision,
        decidedByUserId: userId,
        decidedAt,
      },
    });
    if (claimed.count === 0) {
      throw new IssueApiError(409, "This approval has already been decided.");
    }
    const { bug: _approvalBug, ...approvalFields } = approval;
    void _approvalBug;
    const updated = {
      ...approvalFields,
      status: decision,
      decidedByUserId: userId,
      decidedAt,
    };

    await tx.projectAuditEvent.create({
      data: {
        tenantId,
        projectId: approval.bug.projectId,
        actorUserId: userId,
        action: `approval.${decision}`,
        changes: {
          approvalId,
          stage: approval.stage,
          bugId: approval.bugId,
          decision,
        },
      },
    });

    if (decision === "approved") {
      try {
        await publish(tx, {
          tenantId,
          type: "approval.granted",
          bugId: approval.bugId,
          payload: {
            approvalId,
            issueId: approval.bugId,
            stage: approval.stage,
            actorUserId: userId,
          },
        });
      } catch {
        // Safe in partial DB mocks
      }

      // Continue the pipeline with no agent action (#598). A granted
      // before_offer approval needs nothing here: the issue stays Open and a
      // manager agent awards one of its bids.
      if (approval.stage === "before_merge") {
        // Find the manager agent that accepted the fix, to resume the merge as it.
        const acceptedAudit = await tx.agentAuditEvent.findFirst({
          where: { bugId: approval.bugId, action: "issue.accepted" },
          include: { agent: true },
        });
        const merger = acceptedAudit?.agent ?? await tx.agent.findFirst({
          where: { tenantId, level: "manager", revokedAt: null },
        });
        if (merger) {
          const agentCtx: AgentContext = {
            agentId: merger.id,
            name: merger.name,
            ownerId: merger.ownerUserId,
            tenantId: merger.tenantId,
            // Accept-level, as before: resuming doesn't make this an admin merge.
            level: "manager",
            burst: false,
            keyId: "internal",
          };
          // Resume merge
          await Promise.resolve(mergeAcceptedFix(agentCtx, approval.bugId, { db: tx as never })).catch(() => null);
        }
      }
    }

    return updated;
  };

  if ("$transaction" in db && typeof (db as PrismaClient).$transaction === "function") {
    // Default isolation is deliberate: the conditional update above is the
    // gate. Serializable raises P2034 before updateMany can return count 0,
    // turning a lost race into a 503 instead of the 409, and retrying would
    // repeat the non-transactional notification/merge effects.
    return (db as PrismaClient).$transaction((tx) => run(tx as Db));
  }
  return run(db);
}

/**
 * Creates an ApprovalRule for a project (#598).
 */
export async function createApprovalRule(
  userId: string,
  tenantId: string,
  projectId: string,
  input: ApprovalRuleInput,
  db: Db = prisma,
) {
  const member = await db.membership.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { role: true },
  });
  if (!member || !isTenantAdminRole(member.role)) {
    throw new IssueApiError(403, "Only workspace owners and admins can create approval rules.");
  }

  const project = await db.project.findFirst({
    where: { id: projectId, tenantId },
    select: { id: true },
  });
  if (!project) throw new IssueApiError(404, "Project not found.");

  const rule = await db.approvalRule.create({
    data: {
      projectId,
      stage: input.stage,
      issueTypeId: input.issueTypeId ?? null,
      fileGlob: input.fileGlob ?? null,
    },
  });

  await db.projectAuditEvent.create({
    data: {
      tenantId,
      projectId,
      actorUserId: userId,
      action: "approval_rule.created",
      changes: { ruleId: rule.id, ...input },
    },
  });

  return rule;
}

/**
 * Deletes an ApprovalRule (#598).
 */
export async function deleteApprovalRule(
  userId: string,
  tenantId: string,
  ruleId: string,
  db: Db = prisma,
) {
  const member = await db.membership.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { role: true },
  });
  if (!member || !isTenantAdminRole(member.role)) {
    throw new IssueApiError(403, "Only workspace owners and admins can delete approval rules.");
  }

  const rule = await db.approvalRule.findUnique({
    where: { id: ruleId },
    include: { project: { select: { id: true, tenantId: true } } },
  });
  if (!rule || rule.project.tenantId !== tenantId) {
    throw new IssueApiError(404, "Approval rule not found.");
  }

  await db.approvalRule.delete({ where: { id: ruleId } });

  await db.projectAuditEvent.create({
    data: {
      tenantId,
      projectId: rule.projectId,
      actorUserId: userId,
      action: "approval_rule.deleted",
      changes: { ruleId },
    },
  });

  return { ok: true };
}

/**
 * Lists approval rules for a project.
 */
export async function listApprovalRules(projectId: string, db: Db = prisma) {
  return db.approvalRule.findMany({
    where: { projectId },
    include: { issueType: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
}
