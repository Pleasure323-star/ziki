import type { PrismaClient, Prisma, Severity } from "@prisma/client";
import { audit } from "@/lib/agents/audit";
import { correct } from "@/lib/points/correct";
import { pointSourceKey } from "@/lib/points/rules";
import { isTenantAdminRole } from "@/lib/agents/membership";
import { isConfirmed } from "@/lib/agent-api/validation";

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
 * - `issue.validated` — restores the severity the validation set, drops the
 *   confirmation if fewer than two independent accepts remain, and reverses
 *   the reporter points the confirmation awarded.
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
        return undoValidation(tx, event);
      default:
        return { ok: true, message: "Action marked undone." };
    }
  });
}

/** Reverse an `issue.validated` audit event. */
async function undoValidation(tx: Db, event: AuditEvent): Promise<UndoResult> {
  const payload = (event.payload as {
    validationId?: string;
    confirmed?: boolean;
    severity?: Severity;
    previousSeverity?: Severity | null;
  } | null) ?? {};
  const validationId = payload.validationId;
  if (!validationId) {
    return { ok: true, message: "Validation marked undone." };
  }

  const validation = await tx.issueValidation.findUnique({
    where: { id: validationId },
    select: {
      id: true,
      bugId: true,
      kind: true,
      verdict: true,
      severity: true,
      previousSeverity: true,
    },
  });
  if (!validation) {
    return { ok: true, message: "Validation marked undone." };
  }

  // Restore the severity this validation set, if it changed the issue.
  if (
    validation.previousSeverity !== null &&
    validation.severity !== null &&
    validation.previousSeverity !== validation.severity
  ) {
    await tx.bug.update({
      where: { id: validation.bugId },
      data: { severity: validation.previousSeverity },
    });
  }

  // If this validation was the one that confirmed the issue, reverse the
  // reporter points it awarded. The correction reuses idempotency, so a
  // second undo does not pay twice in reverse.
  if (
    payload.confirmed === true &&
    validation.kind === "real" &&
    validation.verdict === "accept"
  ) {
    const bug = await tx.bug.findUnique({
      where: { id: validation.bugId },
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
  const issue = await tx.bug.findUnique({ where: { id: validation.bugId }, select: { status: true } });
  if (issue?.status === "open" && !(await isConfirmed(validation.bugId, tx))) {
    await tx.bug.update({ where: { id: validation.bugId }, data: { status: "requires_confirmation" } });
  }

  return { ok: true, message: "Validation undone." };
}
