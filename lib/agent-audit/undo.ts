import type { PrismaClient, Prisma } from "@prisma/client";
import { audit } from "@/lib/agents/audit";
import { correct } from "@/lib/points/correct";
import { pointSourceKey } from "@/lib/points/rules";
import { isTenantAdminRole } from "@/lib/agents/membership";
import { isConfirmed } from "@/lib/agent-api/confirmations";

/**
 * Reverses an agent action recorded in the audit log (#450).
 *
 * The original audit row is never deleted: `undoneAt` is stamped on it and a
 * new audit row records the undo, so the admin's own action is audited too.
 *
 * An agent cannot undo an action it performed itself: the actor must not own
 * the agent on the row being undone.
 *
 * Supported reversible actions:
 * - `issue.validated` — an agent's confirmation entry: it stops counting,
 *   the severity it set is restored, the issue goes back to Requires
 *   confirmation if it is no longer confirmed, and the reporter points the
 *   confirmation awarded are reversed.
 */

type Db = PrismaClient | Prisma.TransactionClient;

type AuditEvent = {
  id: string;
  tenantId: string;
  agentId: string | null;
  action: string;
  target: string | null;
  bugId: string | null;
  payload: Prisma.JsonValue | null;
  undoneAt: Date | null;
  agent: { ownerUserId: string | null } | null;
};

export type UndoResult =
  | { ok: true; alreadyUndone: true }
  | { ok: true; message: string }
  | {
      ok: false;
      error: "not_found" | "not_admin" | "cannot_undo_own_agent" | "unsupported";
      message: string;
    };

/**
 * Undo the audited agent event `auditEventId`, performed by `actorUserId`.
 *
 * Returns `{ ok: true, alreadyUndone: true }` when the event was already
 * undone (idempotent — a second undo does nothing).
 */
export async function undoAuditEvent(
  db: PrismaClient,
  args: { auditEventId: string; actorUserId: string; tenantId: string },
): Promise<UndoResult> {
  const { auditEventId, actorUserId, tenantId } = args;

  const event = await db.agentAuditEvent.findUnique({
    where: { id: auditEventId },
    select: {
      id: true,
      tenantId: true,
      agentId: true,
      action: true,
      target: true,
      bugId: true,
      payload: true,
      undoneAt: true,
      agent: { select: { ownerUserId: true } },
    },
  });
  if (!event) {
    return { ok: false, error: "not_found", message: "No such audit event." };
  }
  if (event.tenantId !== tenantId) {
    return { ok: false, error: "not_found", message: "No such audit event in this workspace." };
  }
  if (event.undoneAt) {
    return { ok: true, alreadyUndone: true };
  }

  // Only a workspace admin (owner/admin membership, or the site super admin)
  // may reverse another agent's action.
  const [membership, user] = await Promise.all([
    db.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId: actorUserId } },
      select: { role: true },
    }),
    db.user.findUnique({ where: { id: actorUserId }, select: { role: true } }),
  ]);
  if (!isTenantAdminRole(membership?.role, user?.role)) {
    return {
      ok: false,
      error: "not_admin",
      message: "Only a workspace admin can undo actions.",
    };
  }

  // An agent cannot undo an action performed by an agent it owns.
  if (event.agentId && event.agent?.ownerUserId === actorUserId) {
    return {
      ok: false,
      error: "cannot_undo_own_agent",
      message: "You can't undo an action performed by your own agent.",
    };
  }

  return await db.$transaction(async (tx) => {
    // The original row stays readable; only `undoneAt` is stamped.
    await tx.agentAuditEvent.update({
      where: { id: auditEventId },
      data: { undoneAt: new Date() },
    });

    // Record the undo itself as a new audit row, so the admin's action is
    // audited and published like any other agent action. The undo is
    // performed by a person, so it is recorded under the actor's own agent
    // when they own one in this tenant; otherwise the `undoneAt` stamp on the
    // original row is the audit record.
    const actorAgent = await tx.agent.findFirst({
      where: { ownerUserId: actorUserId, tenantId },
      select: { id: true },
    });
    if (actorAgent) {
      await audit(
        { agentId: actorAgent.id, tenantId },
        "agent.undone",
        `audit:${auditEventId}`,
        {
          undoneEventId: auditEventId,
          originalAction: event.action,
          originalTarget: event.target,
          actorUserId,
        },
        { bugId: event.bugId, actorUserId, db: tx },
      );
    }

    switch (event.action) {
      case "issue.validated":
        return undoConfirmation(tx, event);
      default:
        return { ok: true, message: "Action marked undone." };
    }
  });
}

/**
 * Reverse an `issue.validated` audit event: the agent's confirmation entry
 * (#issue-confirmations; events from before keep the entry's id as
 * `validationId`). The entry stays, marked undone, so it stops counting; it
 * restores the severity it set, reverses the reporter points if it confirmed
 * the issue, and an Open issue that is no longer confirmed goes back to
 * Requires confirmation. If the entry was given again since, the newer entry
 * is left alone.
 */
async function undoConfirmation(tx: Db, event: AuditEvent): Promise<UndoResult> {
  const payload = (event.payload as {
    confirmationId?: string;
    validationId?: string;
    entryAt?: string;
    confirmed?: boolean;
  } | null) ?? {};
  const confirmationId = payload.confirmationId ?? payload.validationId;
  if (!confirmationId) {
    return { ok: true, message: "Confirmation marked undone." };
  }

  const confirmation = await tx.issueConfirmation.findUnique({
    where: { id: confirmationId },
    select: {
      id: true,
      bugId: true,
      verdict: true,
      severity: true,
      previousSeverity: true,
      undoneAt: true,
      updatedAt: true,
    },
  });
  if (!confirmation || confirmation.undoneAt) {
    return { ok: true, message: "Confirmation marked undone." };
  }
  if (payload.entryAt && confirmation.updatedAt.toISOString() !== payload.entryAt) {
    return { ok: true, message: "Confirmation marked undone. It was given again since, so the newer one stands." };
  }

  await tx.issueConfirmation.update({ where: { id: confirmation.id }, data: { undoneAt: new Date() } });

  // Restore the severity this entry set, if it changed the issue.
  if (
    confirmation.previousSeverity !== null &&
    confirmation.severity !== null &&
    confirmation.previousSeverity !== confirmation.severity
  ) {
    await tx.bug.update({
      where: { id: confirmation.bugId },
      data: { severity: confirmation.previousSeverity },
    });
  }

  // If this entry was the one that confirmed the issue, reverse the reporter
  // points it awarded. The correction reuses idempotency, so a second undo
  // does not pay twice in reverse.
  if (payload.confirmed === true && confirmation.verdict === "confirm") {
    const bug = await tx.bug.findUnique({
      where: { id: confirmation.bugId },
      select: { id: true, tenantId: true, beneficiaryUserId: true, reporterId: true },
    });
    if (bug) {
      const userId = bug.beneficiaryUserId ?? bug.reporterId;
      const entry = await tx.pointEntry.findFirst({
        where: {
          tenantId: bug.tenantId,
          sourceKey: pointSourceKey("reporter", bug.id, userId),
        },
        select: { id: true, tenantId: true, userId: true, bugId: true, role: true, points: true },
      });
      if (entry) {
        await correct(tx, { entry });
      }
    }
  }

  // #requires-confirmation: an Open issue that loses its confirmation goes back.
  const issue = await tx.bug.findUnique({ where: { id: confirmation.bugId }, select: { status: true } });
  if (issue?.status === "open" && !(await isConfirmed(confirmation.bugId, tx))) {
    await tx.bug.update({ where: { id: confirmation.bugId }, data: { status: "requires_confirmation" } });
  }

  return { ok: true, message: "Confirmation undone." };
}
