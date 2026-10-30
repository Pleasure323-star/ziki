import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const db = vi.hoisted(() => ({
  agentAuditEvent: {
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  membership: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  agent: { findFirst: vi.fn() },
  issueConfirmation: { findUnique: vi.fn(), update: vi.fn() },
  bug: { findUnique: vi.fn(), update: vi.fn() },
  pointEntry: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

const audit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/audit", () => ({ audit }));

const correct = vi.hoisted(() => vi.fn().mockResolvedValue({ awarded: true, entryId: "entry-1" }));
vi.mock("@/lib/points/correct", () => ({ correct }));

import { undoAuditEvent, type UndoResult } from "./undo";

const actor = "user-admin";
const tenantId = "tenant-zedu";
const eventId = "event-1";

const baseEvent = (overrides: Record<string, unknown> = {}) => ({
  id: eventId,
  tenantId,
  agentId: "agent-1",
  action: "issue.confirmation",
  target: "bug:bug-1",
  bugId: "bug-1",
  payload: {
    confirmationId: "val-1",
    confirmed: true,
    severity: "high",
    previousSeverity: "medium",
  },
  undoneAt: null,
  agent: { ownerUserId: "user-agent-owner" },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.agentAuditEvent.findUnique.mockResolvedValue(baseEvent());
  db.membership.findUnique.mockResolvedValue({ role: "admin" });
  db.user.findUnique.mockResolvedValue({ role: "admin" });
  db.agent.findFirst.mockResolvedValue({ id: "agent-admin" });
});

describe("undoAuditEvent (#450)", () => {
  it("stamps undoneAt on the original audit record and records the undo", async () => {
    const result = await undoAuditEvent(db as unknown as PrismaClient, {
      auditEventId: eventId,
      actorUserId: actor,
      tenantId,
    });

    expect(result).toMatchObject({ ok: true });
    expect((result as { ok: boolean; alreadyUndone?: boolean }).alreadyUndone).toBeUndefined();
    expect(db.agentAuditEvent.update).toHaveBeenCalledWith({
      where: { id: eventId },
      data: { undoneAt: expect.any(Date) },
    });
    expect(audit).toHaveBeenCalledWith(
      { agentId: "agent-admin", tenantId },
      "agent.undone",
      `audit:${eventId}`,
      expect.objectContaining({ undoneEventId: eventId, originalAction: "issue.confirmation" }),
      expect.objectContaining({ bugId: "bug-1", actorUserId: actor }),
    );
  });

  it("is idempotent: a second undo does nothing", async () => {
    db.agentAuditEvent.findUnique.mockResolvedValue(baseEvent({ undoneAt: new Date() }));

    const result = await undoAuditEvent(db as unknown as PrismaClient, {
      auditEventId: eventId,
      actorUserId: actor,
      tenantId,
    });

    expect(result).toMatchObject({ ok: true, alreadyUndone: true });
    expect(db.agentAuditEvent.update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(correct).not.toHaveBeenCalled();
  });

  it("marks the confirmation undone and restores the severity it set (#issue-confirmations)", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "bug-1",
      tenantId,
      beneficiaryUserId: "user-beneficiary",
      reporterId: "user-reporter",
    });
    db.issueConfirmation.findUnique.mockResolvedValue({
      id: "val-1",
      bugId: "bug-1",
      verdict: "confirm",
      severity: "high",
      previousSeverity: "medium",
      undoneAt: null,
      updatedAt: new Date("2026-12-04T10:00:00.000Z"),
    });

    await undoAuditEvent(db as unknown as PrismaClient, {
      auditEventId: eventId,
      actorUserId: actor,
      tenantId,
    });

    expect(db.issueConfirmation.update).toHaveBeenCalledWith({ where: { id: "val-1" }, data: { undoneAt: expect.any(Date) } });
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "bug-1" },
      data: { severity: "medium" },
    });
  });

  it("leaves an entry given again since the audited one alone", async () => {
    db.agentAuditEvent.findUnique.mockResolvedValue(
      baseEvent({ payload: { confirmationId: "val-1", entryAt: "2026-12-04T09:00:00.000Z", confirmed: true } }),
    );
    db.issueConfirmation.findUnique.mockResolvedValue({
      id: "val-1",
      bugId: "bug-1",
      verdict: "confirm",
      severity: "high",
      previousSeverity: "medium",
      undoneAt: null,
      updatedAt: new Date("2026-12-04T10:00:00.000Z"),
    });

    const result = await undoAuditEvent(db as unknown as PrismaClient, { auditEventId: eventId, actorUserId: actor, tenantId });

    expect(result).toMatchObject({ ok: true, message: expect.stringContaining("given again") });
    expect(db.issueConfirmation.update).not.toHaveBeenCalled();
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(correct).not.toHaveBeenCalled();
  });

  it("sends an Open issue that is no longer confirmed back to Requires confirmation", async () => {
    db.issueConfirmation.findUnique.mockResolvedValue({
      id: "val-1",
      bugId: "bug-1",
      verdict: "confirm",
      severity: null,
      previousSeverity: null,
      undoneAt: null,
      updatedAt: new Date("2026-12-04T10:00:00.000Z"),
    });
    db.bug.findUnique.mockResolvedValue({ id: "bug-1", tenantId, beneficiaryUserId: null, reporterId: "user-reporter", status: "open" });

    await undoAuditEvent(db as unknown as PrismaClient, { auditEventId: eventId, actorUserId: actor, tenantId });

    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug-1" }, data: { status: "requires_confirmation" } });
  });

  it("reverses the reporter points when the confirmation confirmed the issue", async () => {
    db.bug.findUnique.mockResolvedValue({
      id: "bug-1",
      tenantId,
      beneficiaryUserId: "user-beneficiary",
      reporterId: "user-reporter",
    });
    db.issueConfirmation.findUnique.mockResolvedValue({
      id: "val-1",
      bugId: "bug-1",
      verdict: "confirm",
      severity: "high",
      previousSeverity: "medium",
      undoneAt: null,
      updatedAt: new Date("2026-12-04T10:00:00.000Z"),
    });
    db.pointEntry.findFirst.mockResolvedValue({
      id: "entry-1",
      tenantId,
      userId: "user-beneficiary",
      bugId: "bug-1",
      role: "reporter",
      points: 5,
    });

    await undoAuditEvent(db as unknown as PrismaClient, {
      auditEventId: eventId,
      actorUserId: actor,
      tenantId,
    });

    expect(db.pointEntry.findFirst).toHaveBeenCalledWith({
      where: { tenantId, sourceKey: "reporter:bug-1:user-beneficiary" },
      select: expect.anything(),
    });
    expect(correct).toHaveBeenCalledWith(
      expect.anything(),
      { entry: expect.objectContaining({ id: "entry-1", points: 5 }) },
    );
  });

  it("does not reverse points when the entry did not confirm", async () => {
    db.agentAuditEvent.findUnique.mockResolvedValue(
      baseEvent({ payload: { confirmationId: "val-1", confirmed: false } }),
    );
    db.issueConfirmation.findUnique.mockResolvedValue({
      id: "val-1",
      bugId: "bug-1",
      verdict: "reject",
      severity: null,
      previousSeverity: null,
      undoneAt: null,
      updatedAt: new Date("2026-12-04T10:00:00.000Z"),
    });

    await undoAuditEvent(db as unknown as PrismaClient, {
      auditEventId: eventId,
      actorUserId: actor,
      tenantId,
    });

    expect(correct).not.toHaveBeenCalled();
  });

  it("refuses a non-admin", async () => {
    db.membership.findUnique.mockResolvedValue({ role: "member" });
    db.user.findUnique.mockResolvedValue({ role: "user" });

    const result = (await undoAuditEvent(db as unknown as PrismaClient, {
      auditEventId: eventId,
      actorUserId: "user-member",
      tenantId,
    })) as UndoResult;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("not_admin");
    expect(db.agentAuditEvent.update).not.toHaveBeenCalled();
  });

  it("refuses when the actor owns the agent that performed the action", async () => {
    db.membership.findUnique.mockResolvedValue({ role: "admin" });
    db.user.findUnique.mockResolvedValue({ role: "admin" });
    db.agentAuditEvent.findUnique.mockResolvedValue(
      baseEvent({ agent: { ownerUserId: actor } }),
    );

    const result = (await undoAuditEvent(db as unknown as PrismaClient, {
      auditEventId: eventId,
      actorUserId: actor,
      tenantId,
    })) as UndoResult;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("cannot_undo_own_agent");
    expect(db.agentAuditEvent.update).not.toHaveBeenCalled();
  });

  it("returns not_found for a missing event", async () => {
    db.agentAuditEvent.findUnique.mockResolvedValue(null);

    const result = (await undoAuditEvent(db as unknown as PrismaClient, {
      auditEventId: "nope",
      actorUserId: actor,
      tenantId,
    })) as UndoResult;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("not_found");
  });

  it("allows an admin to undo another owner's agent action", async () => {
    db.membership.findUnique.mockResolvedValue({ role: "admin" });
    db.user.findUnique.mockResolvedValue({ role: "admin" });
    db.agentAuditEvent.findUnique.mockResolvedValue(
      baseEvent({ agent: { ownerUserId: "someone-else" } }),
    );

    const result = await undoAuditEvent(db as unknown as PrismaClient, {
      auditEventId: eventId,
      actorUserId: actor,
      tenantId,
    });

    expect(result.ok).toBe(true);
    expect(db.agentAuditEvent.update).toHaveBeenCalled();
  });
});
