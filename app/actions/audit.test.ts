import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUser = vi.hoisted(() => vi.fn());
const currentTenantIdFor = vi.hoisted(() => vi.fn());
const isTenantAdmin = vi.hoisted(() => vi.fn());
const undoAuditEvent = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/navigation", () => ({}));
vi.mock("@/lib/auth-helpers", () => ({ requireUser }));
vi.mock("@/lib/tenant-context", () => ({ currentTenantIdFor }));
vi.mock("@/lib/agents/membership", () => ({ isTenantAdmin }));
vi.mock("@/lib/agent-audit/undo", () => ({ undoAuditEvent }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { undoAuditEventAction } from "./audit";

const mockRequireUser = requireUser as unknown as ReturnType<typeof vi.fn>;
const mockCurrentTenantIdFor = currentTenantIdFor as unknown as ReturnType<typeof vi.fn>;
const mockIsTenantAdmin = isTenantAdmin as unknown as ReturnType<typeof vi.fn>;
const mockUndoAuditEvent = undoAuditEvent as unknown as ReturnType<typeof vi.fn>;
const mockRevalidatePath = revalidatePath as unknown as ReturnType<typeof vi.fn>;

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: "user-admin", role: "admin" });
  mockCurrentTenantIdFor.mockResolvedValue("tenant-zedu");
  mockIsTenantAdmin.mockResolvedValue(true);
  mockUndoAuditEvent.mockResolvedValue({ ok: true, message: "undone" });
});

describe("undoAuditEventAction (#450)", () => {
  it("requires a workspace admin", async () => {
    mockIsTenantAdmin.mockResolvedValue(false);
    const result = await undoAuditEventAction(undefined, form({ auditEventId: "event-1" }));

    expect(result).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(mockUndoAuditEvent).not.toHaveBeenCalled();
  });

  it("rejects a missing audit event id", async () => {
    const result = await undoAuditEventAction(undefined, form({}));

    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(mockUndoAuditEvent).not.toHaveBeenCalled();
  });

  it("undoes the event and revalidates the audit page", async () => {
    mockUndoAuditEvent.mockResolvedValue({ ok: true, alreadyUndone: true });
    const result = await undoAuditEventAction(undefined, form({ auditEventId: "event-1" }));

    expect(result).toEqual({ ok: true, message: expect.any(String) });
    expect(mockUndoAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      { auditEventId: "event-1", actorUserId: "user-admin", tenantId: "tenant-zedu" },
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings/audit");
  });

  it("surfaces the undo's human-readable error", async () => {
    mockUndoAuditEvent.mockResolvedValue({
      ok: false,
      error: "not_found",
      message: "No such audit event.",
    } as never);
    const result = await undoAuditEventAction(undefined, form({ auditEventId: "event-1" }));

    expect(result).toEqual({ ok: false, error: "No such audit event." });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
