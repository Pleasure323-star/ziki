import type { AgentLevel, ConfirmationVerdict, Prisma, PrismaClient, Severity } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/agents/audit";
import { reviewerConflict, reviewerCreditConflict, type ReviewerConflict } from "@/lib/agents/independence";
import { IssueApiError } from "@/lib/agent-api/errors";
import { publish } from "@/lib/agent-api/events";
import { ENTRY_SUMMARY_MAX_CHARS, entryDescription, entrySummary } from "@/lib/agent-api/entry-fields";
import { award, type PointAward } from "@/lib/points/award";
import { confirmationReviewerSourceKey, duplicateMarkerSourceKey, pointSourceKey, reviewerPointsAt, triagerClearSourceKey } from "@/lib/points/rules";
import { calculateReporterPoints } from "@/lib/points/project-rewards";
import { getPlatformRewardConfig, getProjectRewardConfig } from "@/lib/points/platform-rewards";
import { severities } from "@/lib/validations/issue";
import { workflowFor } from "@/lib/workflow";
import { parseIssueRef } from "@/lib/issue-ref";
import { statusChangedSummary } from "@/lib/activity-log";
import { readConfirmations, type ReadConfirmation } from "@/lib/issue-stage";

/**
 * Confirmations (#issue-confirmations). An issue at Requires confirmation
 * takes one entry per person: `confirm` (it is real and not a duplicate),
 * `reject` (it is not real, or, with `duplicateOfId`, it duplicates another
 * issue) or `neutral`. Every entry has a summary of at most two sentences and
 * a full description — nobody gives a bare verdict. Giving it again replaces
 * the person's entry. Replies to an entry are plain comments.
 *
 * Agents give entries for their owner (`POST /api/v1/issues/{id}/confirmations`),
 * people in the web app (`app/actions/confirmations.ts`); both come here.
 *
 * - The agent that filed the issue may not, and neither may anyone who is not
 *   independent of it (lib/agents/independence.ts): the reporter, the person
 *   it is for, the owner of the filing agent, or whoever works on it.
 * - A confirm may set severity. Severity only ever rises (#528).
 * - The issue is confirmed once the project's `confirmationsNeeded` distinct
 *   independent people confirmed it (`readConfirmations`, the one rule). It
 *   then moves from Requires confirmation to Open and the reporter earns their
 *   points once (#422, #428).
 * - A counted confirm earns what a "real" accept plus a duplicate clearance
 *   earned before (reviewer + triager points); a duplicate reject earns the
 *   duplicate-marker points. A duplicate earns its reporter and confirmers
 *   nothing.
 */

export const CONFIRMATION_VERDICTS = ["confirm", "reject", "neutral"] as const satisfies readonly ConfirmationVerdict[];
export const CONFIRMATION_SUMMARY_MAX_CHARS = ENTRY_SUMMARY_MAX_CHARS;

const ref = z.string().trim().min(1).max(191);

/** The entry's body. Summary and description follow the idea verdict rules (`ideaVerdictFields`). */
export const confirmationSchema = z
  .object({
    projectId: ref.optional(),
    verdict: z.enum(CONFIRMATION_VERDICTS),
    summary: entrySummary,
    description: entryDescription,
    severity: z.enum(severities).optional(),
    /** With reject: the issue this one duplicates, by id or number. */
    duplicateOfId: ref.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.severity && body.verdict !== "confirm") {
      ctx.addIssue({ code: "custom", path: ["severity"], message: "Severity only goes with confirm." });
    }
    if (body.duplicateOfId && body.verdict !== "reject") {
      ctx.addIssue({ code: "custom", path: ["duplicateOfId"], message: "duplicateOfId only goes with reject: this issue duplicates that one." });
    }
  });

export type ConfirmationInput = z.infer<typeof confirmationSchema>;

/** Who gives the entry: an agent on its owner's behalf, or a person in the web app. */
export type ConfirmationGiver = { tenantId: string; userId: string; agent?: { id: string; level: AgentLevel } };

type Db = PrismaClient | Prisma.TransactionClient;
type Scope = { tenantId: string; projectId: string };

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

function severityRank(severity: Severity | null): number {
  return severity ? SEVERITY_RANK[severity] : 0;
}

/** What the independence rule needs about the issue. */
const bugSelect = {
  id: true,
  number: true,
  tenantId: true,
  projectId: true,
  status: true,
  severity: true,
  isDeleted: true,
  reporterId: true,
  beneficiaryUserId: true,
  assigneeId: true,
  duplicateOfId: true,
  createdByAgentId: true,
  createdByAgent: { select: { ownerUserId: true } },
  claims: { select: { status: true, releasedAt: true, beneficiaryUserId: true, dispatcherUserId: true, agent: { select: { ownerUserId: true } } } },
} satisfies Prisma.BugSelect;

const CONFLICT_MESSAGES: Record<ReviewerConflict, string> = {
  "created-by-own-agent": "An agent of the same owner filed this issue, so its owner can't confirm it.",
  "own-ticket": "This is your own issue (you reported it or it is for you), so you can't confirm it.",
  "claimed-by-own-agent": "An agent of the same owner is working on this issue, so its owner can't confirm it.",
  "assigned-solver": "The person assigned to solve this issue can't confirm it.",
  "claim-beneficiary": "The beneficiary of the active claim can't confirm this issue.",
  "claim-dispatcher": "The dispatcher rewarded for the active claim can't confirm this issue.",
};

function invalid(error: z.ZodError): IssueApiError {
  const issue = error.issues[0];
  const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
  const message =
    field === "verdict" ? "verdict must be confirm, reject or neutral." : issue?.message ?? "Invalid confirmation.";
  return new IssueApiError(400, message, { error: "invalid_request", message, ...(field ? { field } : {}) });
}

/** Parses a raw body, throwing a 400 `IssueApiError` that names the field. */
export function parseConfirmation(raw: unknown): ConfirmationInput {
  const parsed = confirmationSchema.safeParse(raw ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  return parsed.data;
}

/** One issue's confirmation state under the one rule (`readConfirmations`). */
export async function confirmationStateOf(bugId: string, db: Db = prisma): Promise<ReadConfirmation | null> {
  return (await readConfirmations(db, { id: bugId })).get(bugId) ?? null;
}

/** True once the project's required number of independent people confirmed the issue. */
export async function isConfirmed(bugId: string, db: Db = prisma): Promise<boolean> {
  return (await confirmationStateOf(bugId, db))?.confirmed ?? false;
}

/**
 * The point awards a bug's standing confirmations earn (#539): the same
 * entries `giveConfirmation` writes, recomputed so the backfill pays any that
 * were missed. `award()`'s sourceKey makes a repeat a no-op.
 */
export async function standingConfirmationAwards(db: Db, bugId: string): Promise<PointAward[]> {
  const state = await confirmationStateOf(bugId, db);
  if (!state) return [];
  const bug = await db.bug.findUnique({ where: { id: bugId }, select: { tenantId: true, duplicateOfId: true } });
  if (!bug) return [];
  const platform = await getPlatformRewardConfig(db);
  const entries: PointAward[] = [];
  const duplicate = state.duplicate || Boolean(bug.duplicateOfId);
  let reviewerIndex = 0;
  for (const entry of state.counted) {
    const userId = entry.onBehalfOfUserId;
    if (entry.verdict === "confirm") {
      // A confirm is the old "real" accept and the duplicate clearance in one.
      if (!duplicate) {
        entries.push({
          tenantId: bug.tenantId,
          userId,
          bugId,
          role: "reviewer",
          points: reviewerPointsAt(reviewerIndex, platform.confirmationReviewer),
          sourceKey: confirmationReviewerSourceKey(bugId, userId),
        });
      }
      reviewerIndex += 1;
      entries.push({
        tenantId: bug.tenantId,
        userId,
        bugId,
        role: "triager",
        points: platform.triagerClear,
        sourceKey: triagerClearSourceKey(bugId, userId),
      });
    } else if (entry.verdict === "reject" && entry.duplicateOfId) {
      entries.push({
        tenantId: bug.tenantId,
        userId,
        bugId,
        role: "triager",
        points: platform.duplicateMarker,
        sourceKey: duplicateMarkerSourceKey(bugId, userId),
      });
    }
  }
  return entries;
}

export type GivenConfirmation = {
  confirmation: {
    id: string;
    verdict: ConfirmationVerdict;
    summary: string;
    description: string;
    severity: Severity | null;
    duplicateOfId: string | null;
    onBehalfOfUserId: string;
    agentId: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  /** True when this replaced the person's earlier entry. */
  replaced: boolean;
  confirmed: boolean;
  /** True when this entry is the one that confirmed the issue. */
  newlyConfirmed: boolean;
  confirmations: number;
  confirmationsNeeded: number;
};

const NOT_FOUND = "No such issue in this project.";

/** Resolves `duplicateOfId` (an id or a number) to another issue in the tenant. */
async function resolveDuplicate(tx: Prisma.TransactionClient, tenantId: string, bugId: string, raw: string): Promise<string> {
  const parsed = parseIssueRef(raw.replace(/^#/, ""));
  const canonical = await tx.bug.findFirst({
    where: { tenantId, isDeleted: false, ...(parsed.kind === "number" ? { number: parsed.number } : { id: parsed.id }) },
    select: { id: true },
  });
  if (!canonical || canonical.id === bugId) {
    const message = "duplicateOfId must be another issue in this workspace.";
    throw new IssueApiError(400, message, { error: "invalid_request", message, field: "duplicateOfId" });
  }
  return canonical.id;
}

/**
 * Records `giver`'s confirmation entry on an issue (by number or id),
 * replacing any earlier one of theirs. Throws `IssueApiError`.
 */
export async function giveConfirmation(
  giver: ConfirmationGiver,
  scope: Scope,
  issueRef: string,
  raw: unknown,
): Promise<GivenConfirmation> {
  const input = parseConfirmation(raw);
  const parsedRef = parseIssueRef(issueRef);

  return prisma.$transaction(async (tx) => {
    const found = await tx.bug.findFirst({
      where: { ...scope, isDeleted: false, ...(parsedRef.kind === "number" ? { number: parsedRef.number } : { id: parsedRef.id }) },
      select: { id: true },
    });
    if (!found) throw new IssueApiError(404, NOT_FOUND, { error: "not_found", message: NOT_FOUND });
    // Two people can confirm at the same moment. Lock the issue so the second
    // sees the first and the reporter is still paid exactly once.
    await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${found.id} FOR UPDATE`;
    const bug = await tx.bug.findUnique({ where: { id: found.id }, select: bugSelect });
    if (!bug || bug.isDeleted) throw new IssueApiError(404, NOT_FOUND, { error: "not_found", message: NOT_FOUND });

    if (giver.agent && bug.createdByAgentId === giver.agent.id) {
      const message = "The agent that filed an issue can't confirm it.";
      throw new IssueApiError(403, message, { error: "creator_cannot_confirm", message });
    }
    const conflict =
      reviewerConflict({ id: giver.agent?.id ?? "person", ownerUserId: giver.userId }, bug) ??
      reviewerCreditConflict(giver.userId, bug);
    if (conflict) {
      throw new IssueApiError(403, CONFLICT_MESSAGES[conflict], { error: "not_independent", message: CONFLICT_MESSAGES[conflict] });
    }
    if (bug.status !== "requires_confirmation") {
      const message = "This issue is not at Requires confirmation, so it takes no confirmations.";
      throw new IssueApiError(409, message, { error: "not_confirming", message, status: bug.status });
    }

    const duplicateOfId = input.duplicateOfId ? await resolveDuplicate(tx, bug.tenantId, bug.id, input.duplicateOfId) : null;
    const before = await confirmationStateOf(bug.id, tx);
    const wasConfirmed = before?.confirmed ?? false;

    const severity = input.verdict === "confirm" ? input.severity ?? null : null;
    // Confirmers who disagree only ever raise severity: a second one cannot
    // quietly downgrade an issue someone else called critical (#528).
    const escalates = severity !== null && severityRank(severity) > severityRank(bug.severity);
    const severityDisagreement = severity !== null && !escalates && severity !== bug.severity;

    const existing = await tx.issueConfirmation.findUnique({
      where: { bugId_onBehalfOfUserId: { bugId: bug.id, onBehalfOfUserId: giver.userId } },
      select: { id: true },
    });
    const data = {
      agentId: giver.agent?.id ?? null,
      verdict: input.verdict,
      summary: input.summary,
      description: input.description,
      severity,
      previousSeverity: severity ? bug.severity : null,
      duplicateOfId,
      // Giving it again after an undo is a new entry.
      undoneAt: null,
    };
    const confirmation = await tx.issueConfirmation.upsert({
      where: { bugId_onBehalfOfUserId: { bugId: bug.id, onBehalfOfUserId: giver.userId } },
      create: { bugId: bug.id, onBehalfOfUserId: giver.userId, ...data },
      update: data,
      select: {
        id: true, verdict: true, summary: true, description: true, severity: true, duplicateOfId: true,
        onBehalfOfUserId: true, agentId: true, createdAt: true, updatedAt: true,
      },
    });
    if (escalates) await tx.bug.update({ where: { id: bug.id }, data: { severity: severity! } });

    const after = await confirmationStateOf(bug.id, tx);
    const confirmed = after?.confirmed ?? false;
    const newlyConfirmed = confirmed && !wasConfirmed;
    const needed = after?.needed ?? (await workflowFor(bug.projectId, tx)).confirmationsNeeded;

    // #requires-confirmation: a confirmed issue leaves Requires confirmation for Open.
    if (confirmed) {
      await tx.bug.update({ where: { id: bug.id }, data: { status: "open" } });
      await tx.bugActivity.create({
        data: {
          bugId: bug.id,
          actorId: giver.userId,
          type: "status_changed",
          summary: statusChangedSummary("requires_confirmation", "open"),
          metadata: { from: "requires_confirmation", to: "open", via: "confirmed" },
        },
      });
    }

    // Points: the same keys the backfill recomputes (`standingConfirmationAwards`).
    const duplicate = (after?.duplicate ?? false) || Boolean(bug.duplicateOfId);
    const platform = await getPlatformRewardConfig(tx);
    const counted = after?.counted.some((entry) => entry.id === confirmation.id) ?? false;
    if (counted && input.verdict === "confirm") {
      await award(tx, {
        tenantId: bug.tenantId,
        userId: giver.userId,
        bugId: bug.id,
        role: "triager",
        points: platform.triagerClear,
        sourceKey: triagerClearSourceKey(bug.id, giver.userId),
      });
      const index = after?.confirmers.indexOf(giver.userId) ?? -1;
      if (!duplicate && index >= 0) {
        await award(tx, {
          tenantId: bug.tenantId,
          userId: giver.userId,
          bugId: bug.id,
          role: "reviewer",
          points: reviewerPointsAt(index, platform.confirmationReviewer),
          sourceKey: confirmationReviewerSourceKey(bug.id, giver.userId),
        });
      }
    }
    if (counted && input.verdict === "reject" && duplicateOfId) {
      await award(tx, {
        tenantId: bug.tenantId,
        userId: giver.userId,
        bugId: bug.id,
        role: "triager",
        points: platform.duplicateMarker,
        sourceKey: duplicateMarkerSourceKey(bug.id, giver.userId),
      });
    }
    if (newlyConfirmed && !duplicate) {
      // The person the issue is for earns the reporter points (#422), once.
      const userId = bug.beneficiaryUserId ?? bug.reporterId;
      const rewardConfig = await getProjectRewardConfig(tx, bug.projectId);
      await award(tx, {
        tenantId: bug.tenantId,
        userId,
        bugId: bug.id,
        role: "reporter",
        points: calculateReporterPoints(rewardConfig),
        sourceKey: pointSourceKey("reporter", bug.id, userId),
      });
    }

    const payload = {
      confirmationId: confirmation.id,
      // The name agents read before confirmations replaced validations.
      validationId: confirmation.id,
      verdict: input.verdict,
      onBehalfOfUserId: giver.userId,
      summary: input.summary,
      // Lets an undo tell whether the entry was given again since.
      entryAt: confirmation.updatedAt.toISOString(),
      ...(existing ? { replaced: true } : {}),
      ...(severity ? { severity, previousSeverity: bug.severity, effectiveSeverity: escalates ? severity : bug.severity } : {}),
      ...(severityDisagreement ? { severityDisagreement: true } : {}),
      ...(duplicateOfId ? { duplicateOfId } : {}),
      ...(newlyConfirmed ? { confirmed: true } : {}),
    };
    // Only agent actions are audited (and so can be undone); a person's entry is theirs.
    if (giver.agent) {
      await audit({ agentId: giver.agent.id, tenantId: bug.tenantId }, "issue.validated", `bug:${bug.id}`, payload, { bugId: bug.id, db: tx });
    }
    // `issue.validated` keeps the event name agents subscribed to before (#445).
    await publish(tx, { tenantId: bug.tenantId, type: "issue.validated", actorAgentId: giver.agent?.id ?? null, bugId: bug.id, payload });
    if (newlyConfirmed) {
      await publish(tx, {
        tenantId: bug.tenantId,
        type: "issue.confirmed",
        actorAgentId: giver.agent?.id ?? null,
        bugId: bug.id,
        payload: { issueId: bug.id, confirmationId: confirmation.id, validationId: confirmation.id },
      });
    }

    return {
      confirmation,
      replaced: Boolean(existing),
      confirmed,
      newlyConfirmed,
      confirmations: after?.accepts ?? 0,
      confirmationsNeeded: needed,
    };
  });
}

export type ConfirmationReply = {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  agentId: string | null;
  agentName: string | null;
  createdAt: Date;
  editedAt: Date | null;
};

export type ConfirmationView = {
  id: string;
  verdict: ConfirmationVerdict;
  summary: string;
  description: string;
  severity: Severity | null;
  duplicateOf: { id: string; number: number } | null;
  onBehalfOfUserId: string;
  by: string;
  agentId: string | null;
  agentName: string | null;
  /** Whether it counts toward the rule (independent, after the latest edit, not undone). */
  counted: boolean;
  undone: boolean;
  createdAt: Date;
  updatedAt: Date;
  replies: ConfirmationReply[];
};

export type ConfirmationList = {
  issueId: string;
  issueNumber: number;
  status: string;
  confirmed: boolean;
  confirmations: number;
  rejections: number;
  confirmationsNeeded: number;
  entries: ConfirmationView[];
};

/** Every confirmation entry on an issue (by number or id), newest first, with its replies. */
export async function listConfirmations(scope: { tenantId: string; projectId?: string }, issueRef: string, db: PrismaClient = prisma): Promise<ConfirmationList> {
  const parsed = parseIssueRef(issueRef);
  const bug = await db.bug.findFirst({
    where: { ...scope, isDeleted: false, ...(parsed.kind === "number" ? { number: parsed.number } : { id: parsed.id }) },
    select: { id: true, number: true, status: true, projectId: true },
  });
  if (!bug) throw new IssueApiError(404, NOT_FOUND, { error: "not_found", message: NOT_FOUND });
  const [state, rows] = await Promise.all([
    confirmationStateOf(bug.id, db),
    db.issueConfirmation.findMany({
      where: { bugId: bug.id },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: {
        id: true, verdict: true, summary: true, description: true, severity: true, duplicateOfId: true,
        onBehalfOfUserId: true, agentId: true, undoneAt: true, createdAt: true, updatedAt: true,
        onBehalfOf: { select: { name: true } },
        agent: { select: { name: true } },
        replies: {
          where: { deletedAt: null },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true, body: true, authorId: true, agentId: true, createdAt: true, editedAt: true,
            author: { select: { name: true } },
            agent: { select: { name: true } },
          },
        },
      },
    }),
  ]);
  const duplicateIds = [...new Set(rows.map((row) => row.duplicateOfId).filter((id): id is string => Boolean(id)))];
  const duplicates = duplicateIds.length
    ? await db.bug.findMany({ where: { id: { in: duplicateIds } }, select: { id: true, number: true } })
    : [];
  const numbers = new Map(duplicates.map((d) => [d.id, d.number]));
  const counted = new Set(state?.counted.map((entry) => entry.id) ?? []);
  const needed = state?.needed ?? (await workflowFor(bug.projectId, db)).confirmationsNeeded;
  return {
    issueId: bug.id,
    issueNumber: bug.number,
    status: bug.status,
    confirmed: state?.confirmed ?? false,
    confirmations: state?.accepts ?? 0,
    rejections: state?.rejects ?? 0,
    confirmationsNeeded: needed,
    entries: rows.map(({ onBehalfOf, agent, replies, duplicateOfId, undoneAt, ...row }) => ({
      ...row,
      duplicateOf: duplicateOfId && numbers.has(duplicateOfId) ? { id: duplicateOfId, number: numbers.get(duplicateOfId)! } : null,
      by: onBehalfOf.name,
      agentName: agent?.name ?? null,
      counted: counted.has(row.id),
      undone: Boolean(undoneAt),
      replies: replies.map(({ author, agent: replyAgent, ...reply }) => ({
        ...reply,
        authorName: author.name,
        agentName: replyAgent?.name ?? null,
      })),
    })),
  };
}
