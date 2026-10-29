"use server";

import { TICKET_TRIAGE_ERRORS } from "@/lib/ticket-triage";
import { revalidatePath } from "next/cache";
import { revalidateIssue } from "@/lib/revalidate-issue";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { bugInTenant, currentTenantIdFor } from "@/lib/tenant-context";
import { requireUser } from "@/lib/auth-helpers";
import { currentTenantAccess } from "@/lib/tenant-access";
import {
  activityCreateData,
  assigneeChangedSummary,
  categoryChangedSummary,
  severityChangedSummary,
  statusChangedSummary,
  typeChangedSummary,
} from "@/lib/activity-log";
import { validateBulk } from "@/lib/bulk-actions";
import { awardSolver } from "@/lib/points/award";
import { solverAwardForBulkChange } from "@/lib/points/bulk-award";
import { ensureWatching } from "@/lib/watch";
import { notifyLater } from "@/lib/notify";
import type { NotificationEvent } from "@/lib/notifications";
import type { Severity, Status } from "@prisma/client";
import { publish } from "@/lib/agent-api/events";
import { issueChangePayload, publishWebEvent } from "@/lib/agent-api/web-events";

export type BulkResult = {
  error?: string;
  ok?: boolean;
  /** How many issues were actually changed. */
  updated?: number;
  /** Ids that were asked for but not changed, with why. */
  skipped?: { id: string; reason: string }[];
};

/**
 * Apply one triage change to several issues at once.
 *
 * Everything happens in a single transaction: a bulk change that half
 * applied would leave a backlog in a state nobody asked for and no obvious
 * way back. Anything the caller may not touch is reported rather than
 * silently dropped.
 */
export async function bulkUpdateBugsAction(
  rawIds: unknown,
  rawChange: unknown,
): Promise<BulkResult> {
  const user = await requireUser();
  const access = await currentTenantAccess(user.id, user.role);
  if (!access.admin) redirect("/issues");

  const parsed = validateBulk(rawIds, rawChange);
  if (!parsed.ok) return { error: parsed.error };
  const { ids, change } = parsed;
  // Ziki #713: the status moves on its own as agents work; nobody sets it in bulk.
  if ("status" in change && change.status !== undefined) return { error: TICKET_TRIAGE_ERRORS.statusUnauthorized };

  const tenantId = await currentTenantIdFor(user.id);

  // Referenced rows are checked once for the whole batch rather than once
  // per issue, and before the transaction opens.
  let inactiveTypeId: string | undefined;
  if (typeof change.typeId === "string") {
    const type = tenantId
      ? await prisma.issueType.findUnique({
          where: { id_tenantId: { id: change.typeId, tenantId } },
          select: { id: true, isActive: true },
        })
      : null;
    if (!type) return { error: "Issue type not found" };
    if (!type.isActive) inactiveTypeId = type.id;
  }
  if (typeof change.categoryId === "string") {
    const category = tenantId
      ? await prisma.category.findFirst({
          where: { id: change.categoryId, tenantId },
          select: { id: true },
        })
      : null;
    if (!category) return { error: "Platform not found" };
  }
  // Same rule as a single edit: the assignee must belong to this workspace,
  // or a bulk assign would hand the issues (and their solver points) to an
  // outsider.
  if (typeof change.assigneeId === "string") {
    const assignee = tenantId
      ? await prisma.user.findFirst({
          where: { id: change.assigneeId, memberships: { some: { tenantId } } },
          select: { id: true },
        })
      : null;
    if (!assignee) return { error: "Assignee not found in this workspace" };
  }

  // The current values come back too, so each issue's activity entry can say
  // what actually changed on it — the same entries a single edit produces,
  // rather than an opaque "bulk update" line nobody can read later.
  const found = await prisma.bug.findMany({
    where: { id: { in: ids }, ...bugInTenant(tenantId) },
    select: {
      id: true,
      tenantId: true,
      title: true,
      reporterId: true,
      isDeleted: true,
      status: true,
      severity: true,
      assigneeId: true,
      typeId: true,
      categoryId: true,
      type: { select: { name: true } },
      category: { select: { name: true } },
      assignee: { select: { name: true } },
    },
  });

  const byId = new Map(found.map((bug) => [bug.id, bug]));
  const skipped: { id: string; reason: string }[] = [];
  const target: string[] = [];
  type Found = (typeof found)[number];
  const changing: Found[] = [];

  for (const id of ids) {
    const bug = byId.get(id);
    if (!bug) {
      // Someone else deleted it, or the selection outlived the page.
      skipped.push({ id, reason: "No longer exists" });
    } else if (bug.isDeleted) {
      skipped.push({ id, reason: "Deleted — restore it first" });
    } else {
      target.push(id);
      changing.push(bug);
    }
  }

  if (target.length === 0) {
    return { error: "None of the selected issues can be changed.", skipped };
  }

  if (inactiveTypeId && changing.some((bug) => bug.typeId !== inactiveTypeId)) {
    return { error: "Issue type is inactive. Please pick another." };
  }

  // Names for whatever the fields are being set to, looked up once.
  const toNames = await resolveNames(change, tenantId);

  const entries = changing.flatMap((bug) => buildEntries(bug, change, toNames, user.id));

  if (entries.length === 0) {
    // Everything selected already had these values; saying so beats a
    // success message for a change that did nothing.
    return { ok: true, updated: 0, skipped };
  }

  // Only the issues that actually differ. Writing to the rest would bump
  // their updatedAt for no reason, which is visible: it reorders them under
  // the "Recently Updated" sort and overstates what the change did.
  const changedIds = [...new Set(entries.map((entry) => entry.bugId))];

  try {
    await prisma.$transaction(async (tx) => {
      const result = await tx.bug.updateMany({
        // isDeleted is re-checked here, not just in the read above: a
        // concurrent soft delete can commit in between, and filtering on id
        // alone would then edit a deleted issue and log activity for it.
        where: { id: { in: changedIds }, isDeleted: false },
        data: change,
      });
      if (result.count !== changedIds.length) {
        // Something moved underneath us. Throwing rolls the whole thing
        // back rather than logging activity for rows that were not updated.
        throw new BulkRaceError(result.count, changedIds.length);
      }
      for (const terminalStatus of ["resolved", "closed"] as const) {
        const terminalIds = changing
          .filter((bug) => changedIds.includes(bug.id) && change.status === terminalStatus && bug.status !== terminalStatus)
          .map((bug) => bug.id);
        if (terminalIds.length > 0) {
          const activeClaims = typeof tx.issueClaim?.findMany === "function"
            ? await tx.issueClaim.findMany({
                where: { bugId: { in: terminalIds }, status: "active", releasedAt: null },
                select: { id: true, agentId: true, beneficiaryUserId: true, bugId: true },
              })
            : [];
          await tx.issueClaim.updateMany({
            where: { bugId: { in: terminalIds }, status: "active", releasedAt: null },
            data: { status: "released", releasedAt: new Date(), releaseReason: terminalStatus },
          });
          for (const claim of activeClaims) {
            const claimTenantId = byId.get(claim.bugId)?.tenantId ?? tenantId;
            if (!claimTenantId) continue;
            await publish(tx, {
              tenantId: claimTenantId,
              type: "claim.released",
              actorAgentId: claim.agentId,
              bugId: claim.bugId,
              payload: { claimId: claim.id, issueId: claim.bugId, beneficiaryUserId: claim.beneficiaryUserId, reason: terminalStatus },
            });
          }
        }
      }
      await tx.bugActivity.createMany({ data: activityCreateData(entries) });
      // #428: marking issues resolved earns the assignee solver points, once.
      // A bulk status change used to skip the award the single-issue edit writes.
      for (const bug of changing) {
        if (!changedIds.includes(bug.id)) continue;
        if (change.assigneeId && change.assigneeId !== bug.assigneeId) {
          await ensureWatching(tx, bug.id, [change.assigneeId]);
        }
        const target = solverAwardForBulkChange(bug, change);
        if (target) await awardSolver(tx, target);
      }
      // #600: one issue.updated per changed issue, as a single edit would publish.
      for (const id of changedIds) {
        await publishWebEvent(tx, { bugId: id, type: "issue.updated", actorUserId: user.id, payload: issueChangePayload(change) });
      }
    });
  } catch (error) {
    if (error instanceof BulkRaceError) {
      return {
        error:
          "Some of those issues changed while you were selecting them. Nothing was modified — refresh and try again.",
        skipped,
      };
    }
    console.error("[bulk] update failed", error);
    // The transaction rolled back, so nothing changed — say so plainly
    // rather than leaving the caller to guess what landed.
    return { error: "Could not apply the change. Nothing was modified." };
  }

  const events: NotificationEvent[] = [];
  for (const bug of changing) {
    const actor = { actorId: user.id, actorName: user.name ?? "Someone", bugId: bug.id, bugTitle: bug.title };
    if (change.assigneeId !== undefined && change.assigneeId !== bug.assigneeId) {
      events.push({ ...actor, kind: "assignee_changed", fromUserId: bug.assigneeId, toUserId: change.assigneeId });
    }
    if (change.status && change.status !== bug.status) {
      events.push({ ...actor, kind: "status_changed", reporterId: bug.reporterId, from: bug.status, to: change.status as Status });
    }
  }
  if (events.length > 0) notifyLater(...events);

  revalidatePath("/issues");
  revalidatePath("/bugs");
  for (const id of changedIds) {
    revalidateIssue(id);
    revalidatePath(`/bugs/${id}`);
  }

  return { ok: true, updated: changedIds.length, skipped };
}

/** Raised inside the transaction when a row moved between read and write. */
class BulkRaceError extends Error {
  constructor(updated: number, expected: number) {
    super(`bulk update touched ${updated} of ${expected} rows`);
    this.name = "BulkRaceError";
  }
}

type ToNames = { typeId?: string | null; categoryId?: string | null; assigneeId?: string | null };

/** Display names for the ids being assigned, so summaries read properly. */
async function resolveNames(
  change: Record<string, string | null>,
  tenantId: string | null,
): Promise<ToNames> {
  const [type, category, assignee] = await Promise.all([
    typeof change.typeId === "string" && tenantId
      ? prisma.issueType.findUnique({
          where: { id_tenantId: { id: change.typeId, tenantId } },
          select: { name: true },
        })
      : null,
    typeof change.categoryId === "string" && tenantId
      ? prisma.category.findFirst({
          where: { id: change.categoryId, tenantId },
          select: { name: true },
        })
      : null,
    typeof change.assigneeId === "string" && tenantId
      ? prisma.user.findFirst({
          where: { id: change.assigneeId, memberships: { some: { tenantId } } },
          select: { name: true },
        })
      : null,
  ]);
  return {
    typeId: type?.name ?? null,
    categoryId: category?.name ?? null,
    assigneeId: assignee?.name ?? null,
  };
}

type BugRow = {
  id: string;
  tenantId: string;
  status: Status;
  severity: Severity;
  typeId: string | null;
  categoryId: string | null;
  assigneeId: string | null;
  type: { name: string } | null;
  category: { name: string } | null;
  assignee: { name: string } | null;
};

/**
 * One activity entry per field that actually differs on this issue. A field
 * already holding the requested value produces nothing, so the log does not
 * fill with "changed status from Open to Open".
 */
function buildEntries(
  bug: BugRow,
  change: Record<string, string | null>,
  toNames: ToNames,
  actorId: string,
): Parameters<typeof activityCreateData>[0] {
  const entries: Parameters<typeof activityCreateData>[0] = [];
  const base = { bugId: bug.id, actorId };

  if (typeof change.status === "string" && change.status !== bug.status) {
    const to = change.status as Status;
    entries.push({
      ...base,
      type: "status_changed",
      summary: statusChangedSummary(bug.status, to),
      metadata: { field: "status", from: bug.status, to },
    });
  }
  if (typeof change.severity === "string" && change.severity !== bug.severity) {
    const to = change.severity as Severity;
    entries.push({
      ...base,
      type: "severity_changed",
      summary: severityChangedSummary(bug.severity, to),
      metadata: { field: "severity", from: bug.severity, to },
    });
  }
  if (change.typeId !== undefined && change.typeId !== bug.typeId) {
    entries.push({
      ...base,
      type: "type_changed",
      summary: typeChangedSummary(bug.type?.name ?? null, toNames.typeId ?? null),
      metadata: { field: "type", from: bug.type?.name ?? null, to: toNames.typeId ?? null },
    });
  }
  if (change.categoryId !== undefined && change.categoryId !== bug.categoryId) {
    entries.push({
      ...base,
      type: "category_changed",
      summary: categoryChangedSummary(bug.category?.name ?? null, toNames.categoryId ?? null),
      metadata: { field: "category", from: bug.category?.name ?? null, to: toNames.categoryId ?? null },
    });
  }
  if (change.assigneeId !== undefined && change.assigneeId !== bug.assigneeId) {
    entries.push({
      ...base,
      type: "assignee_changed",
      summary: assigneeChangedSummary(bug.assignee?.name ?? null, toNames.assigneeId ?? null),
      metadata: { field: "assignee", from: bug.assignee?.name ?? null, to: toNames.assigneeId ?? null },
    });
  }
  return entries;
}
