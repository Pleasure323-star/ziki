import { Prisma, type PrismaClient, type Severity, type ValidationKind } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/agents/audit";
import { reviewerConflict, reviewerCreditConflict, type ReviewedBug } from "@/lib/agents/independence";
import { hasLevel } from "@/lib/agents/levels";
import type { AgentContext } from "@/lib/agents/require-agent";
import { award, type PointAward } from "@/lib/points/award";
import { confirmationReviewerSourceKey, duplicateMarkerSourceKey, pointSourceKey, reviewerPointsAt, triagerClearSourceKey } from "@/lib/points/rules";
import {
  calculateReporterPoints,
} from "@/lib/points/project-rewards";
import { getPlatformRewardConfig, getProjectRewardConfig } from "@/lib/points/platform-rewards";
import { severities } from "@/lib/validations/issue";
import { publish } from "@/lib/agent-api/events";
import { workflowFor } from "@/lib/workflow";
import { parseIssueRef } from "@/lib/issue-ref";
import { statusChangedSummary } from "@/lib/activity-log";

/** Severity order for the reviewer agreement rule (#528). */
const SEVERITY_RANK: Record<(typeof severities)[number], number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function severityRank(severity: string | null): number {
  return severity && severity in SEVERITY_RANK
    ? SEVERITY_RANK[severity as keyof typeof SEVERITY_RANK]
    : 0;
}

/**
 * Reviewer agents validating issues (#433). A validation says whether an
 * issue is a real bug, whether its report is well formed, whether it is a
 * duplicate, or whether its fix holds up.
 *
 * - Only `reviewer` and `merger` agents may validate.
 * - The agent that filed the issue may not, and neither may any agent that
 *   fails `assertIndependentReviewer` (#442): same owner as the filer, the
 *   issue's own beneficiary, or the owner of the agent holding the claim.
 * - One validation per agent, issue and kind.
 * - Accepting kind `real` sets the issue's severity. It is the only agent
 *   path that does, so it is required there.
 * - An issue is confirmed once the project's required number of independent
 *   reviewers, with different owners, have accepted it as real. When that
 *   first happens the reporter earns their points through `award()` (#428),
 *   once, and each of those reviewers earns confirmation points on a
 *   separate key.
 */

export const VALIDATION_KINDS = ["real", "format", "duplicate", "fix"] as const satisfies readonly ValidationKind[];
export const VALIDATION_VERDICTS = ["accept", "reject"] as const;
export const VALIDATION_NOTES_MAX = 2000;

export const validationBodySchema = z
  .object({
    kind: z.enum(VALIDATION_KINDS),
    verdict: z.enum(VALIDATION_VERDICTS),
    notes: z.string().trim().max(VALIDATION_NOTES_MAX).optional(),
    /** The person the agent acts for; defaults to its owner. */
    onBehalfOfUserId: z.string().trim().min(1).max(191).optional(),
    severity: z.enum(severities).optional(),
    /** For a duplicate verdict: the canonical issue. */
    duplicateOfId: z.string().trim().min(1).max(191).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.kind === "real" && body.verdict === "accept" && !body.severity) {
      ctx.addIssue({
        code: "custom",
        path: ["severity"],
        message: "Accepting an issue as real sets its severity: send low, medium, high or critical.",
      });
    }
    if (body.severity && !(body.kind === "real" && body.verdict === "accept")) {
      ctx.addIssue({
        code: "custom",
        path: ["severity"],
        message: "Severity is only set when accepting an issue as real.",
      });
    }
    if (body.duplicateOfId && body.kind !== "duplicate") {
      ctx.addIssue({
        code: "custom",
        path: ["duplicateOfId"],
        message: "duplicateOfId only goes with kind duplicate.",
      });
    }
  });

export type ValidationBody = z.infer<typeof validationBodySchema>;

type Db = PrismaClient | Prisma.TransactionClient;

type OptionalDbDelegates = {
  bugRevision?: { findFirst?: (args: unknown) => Promise<{ editedAt: Date } | null> };
  issueValidation?: {
    findMany?: (args: unknown) => Promise<unknown[]>;
    count?: (args: unknown) => Promise<number>;
  };
  bug?: { findUnique?: (args: unknown) => Promise<unknown> };
  agentAuditEvent?: { findMany?: (args: unknown) => Promise<unknown[]> };
};

/** What the independence rule and the confirmation count need about an issue. */
const reviewedBugSelect = {
  id: true,
  tenantId: true,
  projectId: true,
  title: true,
  status: true,
  assigneeId: true,
  voteCount: true,
  severity: true,
  reporterId: true,
  beneficiaryUserId: true,
  duplicateOfId: true,
  createdByAgentId: true,
  createdByAgent: { select: { ownerUserId: true } },
  claims: { select: { status: true, releasedAt: true, beneficiaryUserId: true, dispatcherUserId: true, agent: { select: { ownerUserId: true } } } },
} satisfies Prisma.BugSelect;

type LoadedBug = Prisma.BugGetPayload<{ select: typeof reviewedBugSelect }>;

/** Validations whose `issue.validated` audit was undone no longer count (#450). */
async function undoneValidationIds(db: Db, bug: LoadedBug): Promise<Set<string>> {
  const undone = await db.agentAuditEvent.findMany({
    where: {
      tenantId: bug.tenantId,
      action: "issue.validated",
      bugId: bug.id,
      undoneAt: { not: null },
    },
    select: { payload: true },
  });
  return new Set(
    (undone as Array<{ payload: { validationId?: string } | null }>).map(
      (e) => e.payload?.validationId,
    ).filter((id): id is string => Boolean(id)),
  );
}

/** The latest edit timestamp, so pre-edit validations stop counting. */
async function latestRevisionAt(db: Db, bug: LoadedBug): Promise<Date | null> {
  const dbDelegates = db as unknown as OptionalDbDelegates;
  const revision = await dbDelegates.bugRevision?.findFirst?.({
    where: { bugId: bug.id },
    orderBy: { editedAt: "desc" },
    select: { editedAt: true },
  });
  return revision?.editedAt ?? null;
}

/**
 * Claim/assignment independence is enforced at submission under the issue
 * lock (#579). Do not reapply those mutable relationships to accepted
 * validations: a later award must not undo an earlier independent review.
 * Reporter/beneficiary checks, undone audits and revision checks still apply.
 */
function recordedReviewBug(bug: LoadedBug): ReviewedBug {
  return { ...bug, assigneeId: null, claims: [] };
}

/**
 * This agent's validation of `kind` on `bug`, when it was made before the
 * issue's latest edit and so no longer counts (#493). Null otherwise.
 */
async function staleValidationOf(
  db: Db,
  bug: LoadedBug,
  agentId: string,
  kind: ValidationKind,
): Promise<{ id: string } | null> {
  const latestRevision = await latestRevisionAt(db, bug);
  if (!latestRevision) return null;
  const existing = await db.issueValidation.findFirst({
    where: { bugId: bug.id, agentId, kind },
    select: { id: true, createdAt: true },
  });
  return existing && existing.createdAt <= latestRevision ? { id: existing.id } : null;
}

/**
 * People credited for accepts of kind `real` that still count, oldest first.
 * One per owner: a second agent of the same person does not add a credit.
 */
async function countedConfirmationReviewers(db: Db, bug: LoadedBug): Promise<string[]> {
  const dbDelegates = db as unknown as OptionalDbDelegates;
  const latestRevision = await latestRevisionAt(db, bug);

  if (!dbDelegates.issueValidation?.findMany) return [];

  const accepts = await db.issueValidation.findMany({
    where: {
      bugId: bug.id,
      kind: "real",
      verdict: "accept",
      ...(latestRevision ? { createdAt: { gt: latestRevision } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      onBehalfOfUserId: true,
      agentId: true,
      agent: { select: { id: true, ownerUserId: true } },
    },
  });
  const undone = await undoneValidationIds(db, bug);
  const reviewed = recordedReviewBug(bug);
  const owners = new Set<string>();
  const credited: string[] = [];
  for (const { id, onBehalfOfUserId, agent } of accepts) {
    // Retain report-side independence without invalidating a review after
    // its owner subsequently becomes the solver.
    if (agent.id === bug.createdByAgentId) continue;
    if (reviewerConflict({ id: agent.id, ownerUserId: agent.ownerUserId }, reviewed)) continue;
    if (reviewerCreditConflict(onBehalfOfUserId, reviewed)) continue;
    // An undone validation no longer counts toward confirming the issue.
    if (undone.has(id)) continue;
    if (owners.has(agent.ownerUserId)) continue;
    owners.add(agent.ownerUserId);
    credited.push(onBehalfOfUserId);
  }
  return credited;
}

/** Accepts of kind `real` that count toward confirming `bug`. */
async function countedConfirmations(db: Db, bug: LoadedBug): Promise<number> {
  return (await countedConfirmationReviewers(db, bug)).length;
}

/**
 * The third check in confirmation: an agent has looked for duplicates and
 * found none — a `duplicate`-kind validation with verdict `reject`. Any agent
 * class may clear; the same independence rules apply as for reviewers.
 */
async function isTriageCleared(db: Db, bug: LoadedBug): Promise<boolean> {
  const dbDelegates = db as unknown as OptionalDbDelegates;
  if (!dbDelegates.issueValidation?.findMany) return false;
  const latestRevision = await latestRevisionAt(db, bug);
  const clears = await db.issueValidation.findMany({
    where: {
      bugId: bug.id,
      kind: "duplicate",
      verdict: "reject",
      ...(latestRevision ? { createdAt: { gt: latestRevision } } : {}),
    },
    select: {
      id: true,
      agentId: true,
      onBehalfOfUserId: true,
      agent: { select: { id: true, ownerUserId: true, level: true } },
    },
  });
  if (clears.length === 0) return false;
  const undone = await undoneValidationIds(db, bug);
  const reviewed = recordedReviewBug(bug);
  for (const { id, onBehalfOfUserId, agent } of clears as Array<{
    id: string;
    onBehalfOfUserId: string;
    agent: { id: string; ownerUserId: string; level: string };
  }>) {
    if (agent.id === bug.createdByAgentId) continue;
    if (!hasLevel(agent.level as AgentContext["level"], "working")) continue;
    if (reviewerConflict({ id: agent.id, ownerUserId: agent.ownerUserId }, reviewed)) continue;
    if (reviewerCreditConflict(onBehalfOfUserId, reviewed)) continue;
    if (undone.has(id)) continue;
    return true;
  }
  return false;
}

/**
 * True once the project's required independent reviewers accepted the issue as
 * real AND a triager cleared it as not a duplicate (#434 uses this).
 */
export async function isConfirmed(bugId: string, db: Db = prisma): Promise<boolean> {
  const dbDelegates = db as unknown as OptionalDbDelegates;
  if (!dbDelegates.bug?.findUnique) return false;
  const bug = await db.bug.findUnique({ where: { id: bugId }, select: reviewedBugSelect });
  if (!bug) return false;
  const { confirmationsNeeded } = await workflowFor(bug.projectId, db);
  if ((await countedConfirmations(db, bug)) < confirmationsNeeded) return false;
  return isTriageCleared(db, bug);
}

/** Duplicates earn the reporter nothing (#422). */
async function isDuplicate(db: Db, bug: LoadedBug): Promise<boolean> {
  if (bug.duplicateOfId) return true;
  const dbDelegates = db as unknown as OptionalDbDelegates;
  const latestRevision = await dbDelegates.bugRevision?.findFirst?.({
    where: { bugId: bug.id },
    orderBy: { editedAt: "desc" },
    select: { editedAt: true },
  });
  if (!dbDelegates.issueValidation?.count) return false;
  const accepted = await db.issueValidation.count({
    where: {
      bugId: bug.id,
      kind: "duplicate",
      verdict: "accept",
      ...(latestRevision?.editedAt ? { createdAt: { gt: latestRevision.editedAt } } : {}),
    },
  });
  return accepted > 0;
}

/**
 * The point awards a bug's standing validations earn (#539): the same
 * reviewer-confirm, triager-clear and duplicate-marker entries the submit
 * route writes, recomputed so the backfill can pay validations that landed
 * before the award code did. `award()`'s sourceKey makes a repeat a no-op.
 */
export async function standingValidationAwards(db: Db, bugId: string): Promise<PointAward[]> {
  const dbDelegates = db as unknown as OptionalDbDelegates;
  if (
    !dbDelegates.bug?.findUnique ||
    !dbDelegates.issueValidation?.findMany ||
    !dbDelegates.agentAuditEvent?.findMany
  ) {
    return [];
  }
  const bug = await db.bug.findUnique({ where: { id: bugId }, select: reviewedBugSelect });
  if (!bug) return [];

  const platform = await getPlatformRewardConfig(db);
  const entries: PointAward[] = [];

  // Confirming reviewers are skipped entirely once a duplicate marker stands,
  // exactly as at submit time.
  if (!(await isDuplicate(db, bug))) {
    const reviewers = await countedConfirmationReviewers(db, bug);
    reviewers.forEach((userId, index) => {
      entries.push({
        tenantId: bug.tenantId,
        userId,
        bugId,
        role: "reviewer",
        points: reviewerPointsAt(index, platform.confirmationReviewer),
        sourceKey: confirmationReviewerSourceKey(bugId, userId),
      });
    });
  }

  const latestRevision = await latestRevisionAt(db, bug);
  const undone = await undoneValidationIds(db, bug);
  const reviewed = recordedReviewBug(bug);
  const verdicts = await db.issueValidation.findMany({
    where: {
      bugId,
      kind: "duplicate",
      ...(latestRevision ? { createdAt: { gt: latestRevision } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      verdict: true,
      onBehalfOfUserId: true,
      agent: { select: { id: true, ownerUserId: true, level: true } },
    },
  });

  // Each independent person earns once per verdict, as the submit-time award
  // keys do: a reject clears, an accept marks.
  const seen = new Set<string>();
  for (const v of verdicts as Array<{
    id: string;
    verdict: string;
    onBehalfOfUserId: string;
    agent: { id: string; ownerUserId: string; level: string };
  }>) {
    if (undone.has(v.id)) continue;
    if (v.agent.id === bug.createdByAgentId) continue;
    if (reviewerConflict({ id: v.agent.id, ownerUserId: v.agent.ownerUserId }, reviewed)) continue;
    // Duplicates pay the credited person nothing when that person is the
    // reporter or beneficiary (#422, #579).
    if (reviewerCreditConflict(v.onBehalfOfUserId, reviewed)) continue;
    const key = `${v.verdict}:${v.onBehalfOfUserId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (v.verdict === "reject" && hasLevel(v.agent.level as AgentContext["level"], "working")) {
      entries.push({
        tenantId: bug.tenantId,
        userId: v.onBehalfOfUserId,
        bugId,
        role: "triager",
        points: platform.triagerClear,
        sourceKey: triagerClearSourceKey(bugId, v.onBehalfOfUserId),
      });
    } else if (v.verdict === "accept") {
      entries.push({
        tenantId: bug.tenantId,
        userId: v.onBehalfOfUserId,
        bugId,
        role: "triager",
        points: platform.duplicateMarker,
        sourceKey: duplicateMarkerSourceKey(bugId, v.onBehalfOfUserId),
      });
    }
  }

  return entries;
}

export type SubmitValidationResult =
  | {
      status: 201;
      validation: {
        id: string;
        kind: ValidationKind;
        verdict: "accept" | "reject";
        severity: Severity | null;
        duplicateOfId: string | null;
        onBehalfOfUserId: string;
      };
      confirmed: boolean;
      /** True when this validation is the one that confirmed the issue. */
      newlyConfirmed: boolean;
    }
  | { status: 400; error: "invalid_request"; message: string; field?: string }
  | { status: 403; error: "insufficient_level" | "creator_cannot_validate" | "not_independent"; message: string }
  | { status: 404; error: "not_found"; message: string }
  | { status: 409; error: "already_validated"; message: string }
  | { status: 429; error: "rate_limited" };

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function submitValidation(
  agent: AgentContext,
  bugId: string,
  rawBody: unknown,
  beforeWrite?: (tx: Prisma.TransactionClient) => Promise<boolean>,
): Promise<SubmitValidationResult> {
  const parsed = validationBodySchema.safeParse(rawBody ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      status: 400,
      error: "invalid_request",
      message: issue?.message ?? "Invalid validation.",
      field: typeof issue?.path[0] === "string" ? issue.path[0] : undefined,
    };
  }
  const body = parsed.data;

  // Every agent class may triage and validate; owner independence and the
  // quorum below are what keep a verdict honest (#433, #442).

  const ref = parseIssueRef(bugId);
  const bug = await prisma.bug.findFirst({
    where: {
      ...(ref.kind === "number" ? { number: ref.number } : { id: ref.id }),
      tenantId: agent.tenantId,
      ...(agent.projectId ? { projectId: agent.projectId } : {}),
      isDeleted: false,
    },
    select: reviewedBugSelect,
  });
  if (!bug) return { status: 404, error: "not_found", message: "No such issue in this agent's tenant." };

  if (bug.createdByAgentId === agent.agentId) {
    return {
      status: 403,
      error: "creator_cannot_validate",
      message: "The agent that filed an issue can't validate it.",
    };
  }
  const conflict = reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, bug);
  if (conflict) {
    return {
      status: 403,
      error: "not_independent",
      message:
        conflict === "own-ticket"
          ? "This issue is for the agent's owner, so this agent can't validate it."
          : conflict === "created-by-own-agent"
            ? "An agent of the same owner filed this issue, so this agent can't validate it."
            : "An agent of the same owner is working on this issue, so this agent can't validate it.",
    };
  }

  const onBehalfOfUserId = body.onBehalfOfUserId ?? agent.ownerId;
  if (onBehalfOfUserId !== agent.ownerId) {
    const member = await prisma.membership.findUnique({
      where: { tenantId_userId: { tenantId: agent.tenantId, userId: onBehalfOfUserId } },
      select: { id: true },
    });
    if (!member) {
      return {
        status: 400,
        error: "invalid_request",
        message: "onBehalfOfUserId must be a member of the agent's tenant.",
        field: "onBehalfOfUserId",
      };
    }
  }
  if (reviewerCreditConflict(onBehalfOfUserId, bug as ReviewedBug)) {
    return {
      status: 403,
      error: "not_independent",
      message: "onBehalfOfUserId must be independent of the issue's reporter, solver, and claim beneficiary.",
    };
  }

  if (body.duplicateOfId) {
    const canonical =
      body.duplicateOfId === bug.id
        ? null
        : await prisma.bug.findFirst({
            where: { id: body.duplicateOfId, tenantId: agent.tenantId, isDeleted: false },
            select: { id: true },
          });
    if (!canonical) {
      return {
        status: 400,
        error: "invalid_request",
        message: "duplicateOfId must be another issue in this tenant.",
        field: "duplicateOfId",
      };
    }
  }

  const setsSeverity = body.kind === "real" && body.verdict === "accept" ? body.severity! : null;
  // Reviewers who disagree only ever raise severity: a second reviewer cannot
  // quietly downgrade an issue someone else called critical (#528).
  const escalatesSeverity =
    setsSeverity !== null && severityRank(setsSeverity) > severityRank(bug.severity);
  const severityDisagreement =
    setsSeverity !== null && !escalatesSeverity && setsSeverity !== bug.severity;

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Two reviewers can confirm at the same moment. Lock the issue so the
      // second transaction sees the first accept and still pays the reporter.
      await tx.$queryRaw`SELECT "id" FROM "Bug" WHERE "id" = ${bug.id} FOR UPDATE`;
      // Awarding a bid also locks this row. Recheck after acquiring the lock
      // so an award between preflight and insertion cannot admit a conflicted
      // validation that the historical confirmation count would then trust.
      const currentBug = await tx.bug.findUnique({
        where: { id: bug.id },
        select: { ...reviewedBugSelect, isDeleted: true },
      });
      if (!currentBug || currentBug.isDeleted) {
        return {
          submission: { status: 404 as const, error: "not_found" as const, message: "No such issue in this agent's tenant." },
        };
      }
      if (
        reviewerConflict({ id: agent.agentId, ownerUserId: agent.ownerId }, currentBug) ||
        reviewerCreditConflict(onBehalfOfUserId, currentBug)
      ) {
        return {
          submission: { status: 403 as const, error: "not_independent" as const, message: "The reviewer and credited person must be independent when the validation is recorded." },
        };
      }
      // Rate limiting is part of this transaction, so expected permission and
      // independence refusals do not spend a write. A rejected budget gate
      // also commits no validation or rate-limit hit.
      if (beforeWrite && !(await beforeWrite(tx))) {
        return {
          submission: { status: 429 as const, error: "rate_limited" as const },
        };
      }
      const { confirmationsNeeded } = await workflowFor(bug.projectId, tx);
      const wasConfirmed =
        (await countedConfirmations(tx, bug)) >= confirmationsNeeded &&
        (await isTriageCleared(tx, bug));

      const fields = {
        onBehalfOfUserId,
        verdict: body.verdict,
        notes: body.notes || null,
        duplicateOfId: body.duplicateOfId ?? null,
        severity: setsSeverity,
        previousSeverity: setsSeverity ? bug.severity : null,
      };
      const validationSelect = { id: true, kind: true, verdict: true, severity: true, duplicateOfId: true, onBehalfOfUserId: true } as const;
      // #493: an edit voids earlier validations, and an agent has one row per
      // issue and kind. When this agent's row predates the latest edit, the
      // re-review replaces it instead of being refused forever. A row made
      // after the edit still gets 409. The stale row is deleted, not updated,
      // so the replacement gets a new id: an undo of the old review (which
      // keys on its validationId) can neither hide nor reverse the new one.
      // Its `issue.validated` audit event stays as history.
      const stale = await staleValidationOf(tx, bug, agent.agentId, body.kind);
      if (stale) await tx.issueValidation.delete({ where: { id: stale.id } });
      const validation = await tx.issueValidation.create({
        data: { bugId: bug.id, agentId: agent.agentId, kind: body.kind, ...fields },
        select: validationSelect,
      });
      if (escalatesSeverity) {
        await tx.bug.update({ where: { id: bug.id }, data: { severity: setsSeverity! } });
      }

      const confirmed =
        (await countedConfirmations(tx, bug)) >= confirmationsNeeded &&
        (await isTriageCleared(tx, bug));
      const newlyConfirmed = confirmed && !wasConfirmed;
      // #requires-confirmation: a confirmed issue leaves Requires confirmation for Open.
      if (confirmed && bug.status === "requires_confirmation") {
        await tx.bug.update({ where: { id: bug.id }, data: { status: "open" } });
        await tx.bugActivity.create({
          data: {
            bugId: bug.id,
            actorId: onBehalfOfUserId,
            type: "status_changed",
            summary: statusChangedSummary("requires_confirmation", "open"),
            metadata: { from: "requires_confirmation", to: "open", via: "confirmed" },
          },
        });
      }
      const duplicate = await isDuplicate(tx, bug);
      const platform = await getPlatformRewardConfig(tx);
      if (body.kind === "duplicate") {
        // The duplicate pass pays its own role (#428): clear vs mark amounts
        // come from platform settings (hard-coded fallback).
        const sourceKey =
          body.verdict === "reject" && hasLevel(agent.level, "working")
            ? triagerClearSourceKey(bug.id, onBehalfOfUserId)
            : body.verdict === "accept"
              ? duplicateMarkerSourceKey(bug.id, onBehalfOfUserId)
              : null;
        if (sourceKey) {
          await award(tx, {
            tenantId: bug.tenantId,
            userId: onBehalfOfUserId,
            bugId: bug.id,
            role: "triager",
            points: body.verdict === "reject" ? platform.triagerClear : platform.duplicateMarker,
            sourceKey,
          });
        }
      }
      if (body.kind === "real" && body.verdict === "accept" && !duplicate) {
        const reviewers = await countedConfirmationReviewers(tx, bug);
        const index = reviewers.indexOf(onBehalfOfUserId);
        if (index >= 0) {
          await award(tx, {
            tenantId: bug.tenantId,
            userId: onBehalfOfUserId,
            bugId: bug.id,
            role: "reviewer",
            points: reviewerPointsAt(index, platform.confirmationReviewer),
            sourceKey: confirmationReviewerSourceKey(bug.id, onBehalfOfUserId),
          });
        }
      }
      if (newlyConfirmed && !duplicate) {
        // The person the issue is for earns the reporter points (#422), once:
        // the sourceKey makes a second award, or the backfill (#435), a no-op.
        const userId = bug.beneficiaryUserId ?? bug.reporterId;
        const rewardConfig = await getProjectRewardConfig(tx, bug.projectId);
        const points = calculateReporterPoints(rewardConfig);
        await award(tx, {
          tenantId: bug.tenantId,
          userId,
          bugId: bug.id,
          role: "reporter",
          points,
          sourceKey: pointSourceKey("reporter", bug.id, userId),
        });
      }

      await audit(
        agent,
        "issue.validated",
        `bug:${bug.id}`,
        {
          validationId: validation.id,
          kind: body.kind,
          verdict: body.verdict,
          onBehalfOfUserId,
          ...(setsSeverity ? { severity: setsSeverity, previousSeverity: bug.severity, effectiveSeverity: escalatesSeverity ? setsSeverity : bug.severity } : {}),
          ...(severityDisagreement ? { severityDisagreement: true } : {}),
          ...(body.duplicateOfId ? { duplicateOfId: body.duplicateOfId } : {}),
          ...(newlyConfirmed ? { confirmed: true } : {}),
        },
        { bugId: bug.id, db: tx },
      );

      // Publish "issue.validated" event to the agent event feed (#445)
      await publish(tx, {
        tenantId: bug.tenantId,
        type: "issue.validated",
        actorAgentId: agent.agentId,
        bugId: bug.id,
        payload: {
          validationId: validation.id,
          kind: body.kind,
          verdict: body.verdict,
          onBehalfOfUserId,
          ...(setsSeverity ? { severity: setsSeverity, previousSeverity: bug.severity, effectiveSeverity: escalatesSeverity ? setsSeverity : bug.severity } : {}),
          ...(severityDisagreement ? { severityDisagreement: true } : {}),
          ...(body.duplicateOfId ? { duplicateOfId: body.duplicateOfId } : {}),
          ...(newlyConfirmed ? { confirmed: true } : {}),
        },
      });

      // Confirmation is its own feed/webhook event, so polling agents that
      // only watch for confirmations do not have to parse every validation (#534).
      if (newlyConfirmed) {
        await publish(tx, {
          tenantId: bug.tenantId,
          type: "issue.confirmed",
          actorAgentId: agent.agentId,
          bugId: bug.id,
          payload: {
            issueId: bug.id,
            validationId: validation.id,
          },
        });
      }

      // #idea-verdicts: a confirmed issue is not offered automatically. It
      // waits for bids, an offer request or a manager agent's dispatch.
      return { submission: { status: 201 as const, validation, confirmed, newlyConfirmed } };
    });
    return outcome.submission;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return {
      status: 409,
      error: "already_validated",
      message: `This agent has already submitted a ${body.kind} validation for this issue.`,
    };
  }
}
