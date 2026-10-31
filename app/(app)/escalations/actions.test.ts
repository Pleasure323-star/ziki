import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  membership: { findUnique: vi.fn() },
  agentQuestion: { findFirst: vi.fn(), updateMany: vi.fn() },
  agentAuditEvent: { create: vi.fn() },
  agentEvent: { create: vi.fn() },
  webhookSubscription: { findMany: vi.fn() },
  webhookDelivery: { createMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

vi.mock("@/lib/auth-helpers", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "user-1", email: "user@example.com" }),
}));

vi.mock("@/lib/tenant-context", () => ({
  currentTenantIdFor: vi.fn().mockResolvedValue("tenant-1"),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  unstable_cache: (fn: (...a: unknown[]) => unknown) => fn,
}));

import {
  answerEscalationAction,
  quickResolveEscalationAction,
} from "./actions";
import { revalidatePath } from "next/cache";

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation((run: (tx: typeof db) => unknown) => run(db));
  db.membership.findUnique.mockResolvedValue({ userId: "user-1" });
  db.agentQuestion.findFirst.mockResolvedValue({
    id: "esc-1",
    agentId: "agent-1",
    bugId: null,
    ownerUserId: "user-1",
  });
  db.agentQuestion.updateMany.mockResolvedValue({ count: 1 });
  db.agentAuditEvent.create.mockResolvedValue({});
  db.agentEvent.create.mockResolvedValue({ id: "e1" });
  db.webhookSubscription.findMany.mockResolvedValue([]);
});

describe("quickResolveEscalationAction (#763)", () => {
  it("refuses another owner's private request without mutating or revalidating", async () => {
    db.agentQuestion.findFirst.mockResolvedValue({ id: "esc-1", agentId: "agent-2", bugId: null, ownerUserId: "other-owner" });
    expect(await quickResolveEscalationAction("esc-1", "approve")).toEqual({ ok: false, error: expect.any(String) });
    expect(db.agentQuestion.updateMany).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reports a concurrent answer without revalidating", async () => {
    db.agentQuestion.updateMany.mockResolvedValue({ count: 0 });
    expect(await quickResolveEscalationAction("esc-1", "approve")).toEqual({ ok: false, error: expect.any(String) });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("resolves escalation with approve message", async () => {
    const result = await quickResolveEscalationAction("esc-1", "approve");
    expect(result).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/activity");
    expect(db.agentQuestion.updateMany).toHaveBeenCalledWith({
      where: { id: "esc-1", answer: null },
      data: expect.objectContaining({
        answer: "Approved. Proceed with your proposed approach.",
        answeredAt: expect.any(Date),
      }),
    });
  });

  it("resolves escalation with authorize message", async () => {
    const result = await quickResolveEscalationAction("esc-1", "authorize");
    expect(result).toEqual({ ok: true });
    expect(db.agentQuestion.updateMany).toHaveBeenCalledWith({
      where: { id: "esc-1", answer: null },
      data: expect.objectContaining({
        answer: "Work authorized. You may begin implementation.",
        answeredAt: expect.any(Date),
      }),
    });
  });
});

describe("answerEscalationAction (#763)", () => {
  it("records a custom answer", async () => {
    const formData = new FormData();
    formData.set("escalationId", "esc-1");
    formData.set("answer", "Custom human response.");

    const result = await answerEscalationAction(undefined, formData);
    expect(result).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/activity");
    expect(db.agentQuestion.updateMany).toHaveBeenCalledWith({
      where: { id: "esc-1", answer: null },
      data: expect.objectContaining({
        answer: "Custom human response.",
        answeredAt: expect.any(Date),
      }),
    });
  });

  it("rejects empty answer", async () => {
    const formData = new FormData();
    formData.set("escalationId", "esc-1");
    formData.set("answer", "   ");

    const result = await answerEscalationAction(undefined, formData);
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(db.agentQuestion.updateMany).not.toHaveBeenCalled();
  });
});
