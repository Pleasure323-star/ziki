import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_PAGE_SIZE, activityBefore, activityFilters, activityHref, activityPage } from "./paging";

const db = vi.hoisted(() => ({
  membership: { findUnique: vi.fn() },
  agentQuestion: { findMany: vi.fn() },
  issueClaim: { findMany: vi.fn() },
  agentAuditEvent: { findMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
import { loadAgentCenter } from "./queries";

beforeEach(() => {
  vi.clearAllMocks();
  db.membership.findUnique.mockResolvedValue({ role: "member" });
  for (const table of [db.agentQuestion, db.issueClaim, db.agentAuditEvent]) table.findMany.mockResolvedValue([]);
});

describe("activity authorization and privacy", () => {
  it("does not query data without a workspace or membership", async () => {
    expect(await loadAgentCenter("u1", null)).toBeNull();
    expect(db.membership.findUnique).not.toHaveBeenCalled();
    db.membership.findUnique.mockResolvedValue(null);
    expect(await loadAgentCenter("u1", "foreign")).toBeNull();
    expect(db.membership.findUnique).toHaveBeenCalledWith({ where: { tenantId_userId: { tenantId: "foreign", userId: "u1" } }, select: { role: true } });
    for (const table of [db.agentQuestion, db.issueClaim, db.agentAuditEvent]) expect(table.findMany).not.toHaveBeenCalled();
  });

  it("scopes ordinary members' work and audit to their own agents", async () => {
    const data = await loadAgentCenter("u1", "t1");
    expect(data?.isAdmin).toBe(false);
    const work = db.issueClaim.findMany.mock.calls[0][0];
    expect(work.where.AND[0]).toEqual({ agent: { tenantId: "t1", ownerUserId: "u1" }, bug: { tenantId: "t1", isDeleted: false } });
    const audit = db.agentAuditEvent.findMany.mock.calls[0][0];
    expect(audit.where.AND).toContainEqual({ agent: { tenantId: "t1", ownerUserId: "u1" } });
    expect(audit.where.AND[0]).toEqual({ tenantId: "t1", NOT: { payload: { path: ["request"], equals: true } } });
  });

  it.each(["admin", "owner"])("allows %s workspace history but keeps escalations private", async (role) => {
    db.membership.findUnique.mockResolvedValue({ role });
    const data = await loadAgentCenter("u1", "t1");
    expect(data?.isAdmin).toBe(true);
    expect(db.issueClaim.findMany.mock.calls[0][0].where.AND[0].agent).toEqual({ tenantId: "t1" });
    expect(db.agentQuestion.findMany.mock.calls[0][0].where.AND[0]).toEqual({ ownerUserId: "u1", agent: { tenantId: "t1" }, answeredAt: null });
  });

  it("never selects private answers, raw audit payloads or key material", async () => {
    await loadAgentCenter("u1", "t1");
    const questions = db.agentQuestion.findMany.mock.calls[0][0];
    expect(questions.select.answer).toBeUndefined();
    const events = db.agentAuditEvent.findMany.mock.calls[0][0];
    expect(events.select.payload).toBeUndefined();
    expect(events.select.target).toBeUndefined();
    expect(events.select.agent).toEqual({ select: { name: true } });
    expect(events.where.AND).toContainEqual({ OR: [{ bugId: null }, { bug: { tenantId: "t1", isDeleted: false } }] });
  });

  it("applies issue filters to every list and claim state only to work", async () => {
    db.membership.findUnique.mockResolvedValue({ role: "admin" });
    await loadAgentCenter("u1", "t1", { issue: "#123", state: "released" });
    for (const table of [db.agentQuestion, db.issueClaim, db.agentAuditEvent]) {
      const query = table.findMany.mock.calls[0][0];
      expect(JSON.stringify(query.where)).toContain('"number":123');
      expect(query.take).toBe(ACTIVITY_PAGE_SIZE + 1);
      expect(query.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    }
    expect(db.issueClaim.findMany.mock.calls[0][0].where.AND[0].status).toBe("released");
  });
});

describe("bounded activity pagination", () => {
  const rows = Array.from({ length: ACTIVITY_PAGE_SIZE + 1 }, (_, i) => ({ id: `row-${i}`, createdAt: new Date("2026-10-27T12:00:00Z") }));

  it("fetches one extra row and resumes using timestamp/id without depending on a surviving row", async () => {
    db.agentQuestion.findMany.mockResolvedValue(rows);
    const first = await loadAgentCenter("u1", "t1");
    expect(first?.questions.items).toHaveLength(ACTIVITY_PAGE_SIZE);
    const cursor = first!.questions.next!;
    db.agentQuestion.findMany.mockResolvedValue([]); // pending rows may have been answered meanwhile
    await loadAgentCenter("u1", "t1", { questions: cursor });
    const query = db.agentQuestion.findMany.mock.calls[1][0];
    expect(query.cursor).toBeUndefined();
    expect(query.where.AND).toContainEqual({ OR: [
      { createdAt: { lt: rows[19].createdAt } }, { createdAt: rows[19].createdAt, id: { lt: "row-19" } },
    ] });
    expect(activityPage(rows.slice(0, 20)).next).toBeNull();
  });

  it("preserves filters and independent cursors in links", () => {
    const href = activityHref({ issue: "42", state: "active", work: "work-cursor", events: "old" }, "events", "next");
    expect(href).toBe("/activity?issue=42&state=active&work=work-cursor&events=next#events");
    expect(activityHref({ work: "old" }, "work", null)).toBe("/activity#work");
  });

  it.each(["garbage", "x".repeat(513), Buffer.from('["bad-date","id"]').toString("base64url"), Buffer.from('{}').toString("base64url")])("ignores invalid cursors: %s", (cursor) => {
    expect(activityBefore(cursor)).toBeUndefined();
  });

  it("makes invalid issue filters match nothing and normalizes repeated values", () => {
    expect(activityFilters({ issue: "nope", state: "bogus" })).toEqual({ issue: "nope", issueNumber: -1, state: "all" });
    expect(activityFilters({ issue: ["#123", "456"], state: ["active", "released"] }).issueNumber).toBe(123);
    expect(activityFilters({ issue: "999999999999" }).issueNumber).toBe(-1);
  });
});
