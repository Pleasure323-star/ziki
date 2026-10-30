import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  agentApiKey: { findUnique: vi.fn() }, agentAuditEvent: { create: vi.fn() },
  agentEvent: { create: vi.fn() }, webhookSubscription: { findMany: vi.fn() },
  webhookDelivery: { createMany: vi.fn() },
  project: { findFirst: vi.fn(), findUnique: vi.fn() },
  issueClaim: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), count: vi.fn(), create: vi.fn(), groupBy: vi.fn() },
  membership: { findMany: vi.fn() },
  agentQuestion: { findFirst: vi.fn(), updateMany: vi.fn() },
  bug: { updateMany: vi.fn(), findFirst: vi.fn() }, $queryRaw: vi.fn(), $transaction: vi.fn(),
}));
const mocks = vi.hoisted(() => ({ admin: vi.fn(), budget: vi.fn(), notifyLater: vi.fn(), workflow: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/workflow", async (original) => ({
  ...await original<typeof import("@/lib/workflow")>(),
  workflowFor: mocks.workflow,
}));
vi.mock("@/lib/auth-helpers", () => ({ requireSuperAdmin: mocks.admin }));
vi.mock("@/lib/agents/rate-budget", async (original) => ({ ...await original<typeof import("@/lib/agents/rate-budget")>(), consumeAgentBudget: mocks.budget }));
vi.mock("@/lib/notify", () => ({ notifyLater: mocks.notifyLater }));
import { releaseStaleClaims, sweepStaleClaims } from "./availability";
import { DEFAULT_PROJECT_WORKFLOW } from "@/lib/workflow-config";
import { POST } from "@/app/api/v1/issues/[id]/heartbeat/route";

const now = new Date("2026-10-19T12:00:00Z");
const cutoff = new Date(now.getTime() - DEFAULT_PROJECT_WORKFLOW.heartbeatMinutes * 60 * 1000);
const stale = new Date(cutoff.getTime() - 1);
const claim = { id: "claim", bugId: "issue", agentId: "agent", beneficiaryUserId: "owner", status: "active", releasedAt: null, claimedAt: stale, lastHeartbeatAt: stale };
const context = { params: Promise.resolve({ id: "issue" }) };
function request(query = "?projectId=project", key = true) {
  return new NextRequest(`http://localhost/api/v1/issues/issue/heartbeat${query}`, { method: "POST", headers: key ? { authorization: "Bearer ziki_test" } : {} });
}
beforeEach(() => {
  vi.resetAllMocks();
  // setTimeout is faked so the re-offer's expiry timer is armed but never fires.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout"] }); vi.setSystemTime(now);
  db.agentApiKey.findUnique.mockResolvedValue({ id: "key", revokedAt: null, agent: { id: "agent", name: "Agent", ownerUserId: "owner", tenantId: "tenant", level: "working", burst: false, revokedAt: null, owner: { memberships: [{ tenantId: "tenant" }] } } });
  db.project.findFirst.mockResolvedValue({ id: "project" });
  db.project.findUnique.mockResolvedValue({ id: "project", tenantId: "tenant" });
  db.$queryRaw.mockResolvedValue([{ id: "issue" }]);
  db.$transaction.mockImplementation((run) => run(db));
  db.issueClaim.findFirst.mockResolvedValue(claim);
  db.issueClaim.findMany.mockResolvedValue([{ id: "claim", bugId: "issue", bug: { tenantId: "tenant", projectId: "project" } }]);
  db.issueClaim.update.mockResolvedValue({ ...claim, lastHeartbeatAt: now });
  db.issueClaim.count.mockResolvedValue(0);
  db.issueClaim.create.mockResolvedValue({ id: "claim-next", bugId: "issue", offeredAt: now });
  db.issueClaim.groupBy.mockResolvedValue([]);
  db.membership.findMany.mockResolvedValue([]);
  db.bug.updateMany.mockResolvedValue({ count: 1 });
  db.bug.findFirst.mockResolvedValue({ id: "issue", projectId: "project", title: "Bug", assigneeId: null, status: "open" });
  db.agentEvent.create.mockResolvedValue({ id: "evt" });
  db.webhookSubscription.findMany.mockResolvedValue([]);
  mocks.admin.mockResolvedValue({ id: "admin" });
  mocks.budget.mockResolvedValue({ allowed: true });
  mocks.workflow.mockResolvedValue(DEFAULT_PROJECT_WORKFLOW);
});
afterEach(() => vi.useRealTimers());

describe("project heartbeat window (#595)", () => {
  it("uses the project's one-minute silence window", async () => {
    mocks.workflow.mockResolvedValue({ ...DEFAULT_PROJECT_WORKFLOW, heartbeatMinutes: 1 });
    const minuteCutoff = new Date(now.getTime() - 60_000);

    await releaseStaleClaims("project");

    expect(db.issueClaim.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { lastHeartbeatAt: { lt: minuteCutoff }, bug: { pullRequestUrl: null } },
            { lastHeartbeatAt: null, claimedAt: { lt: minuteCutoff }, bug: { pullRequestUrl: null } },
            { deliverBy: { lt: now }, bug: { pullRequestUrl: null } },
          ],
        }),
      }),
    );
  });
});

describe("claim heartbeats", () => {
  it("advances the claiming agent's timestamp under the scoped issue lock", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(db.issueClaim.update).toHaveBeenCalledWith({ where: { id: "claim" }, data: { lastHeartbeatAt: now } });
    const [sql, ...values] = db.$queryRaw.mock.calls[0];
    expect(sql.join("?")).toContain("FOR NO KEY UPDATE");
    expect(values).toEqual(["issue", "tenant", "project"]);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.issueClaim.findFirst.mock.invocationCallOrder[0]);
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "claims.heartbeat", payload: { status: 200, request: true } }) });
  });
  it("rejects another agent, offered claims, and absent/released claims", async () => {
    db.issueClaim.findFirst.mockResolvedValueOnce({ ...claim, agentId: "other" });
    expect((await POST(request(), context)).status).toBe(403);
    db.issueClaim.findFirst.mockResolvedValueOnce({ ...claim, status: "offered" });
    expect((await POST(request(), context)).status).toBe(409);
    db.issueClaim.findFirst.mockResolvedValueOnce(null);
    expect((await POST(request(), context)).status).toBe(409);
    expect(db.issueClaim.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { bugId: "issue", releasedAt: null } }));
    expect(db.issueClaim.update).not.toHaveBeenCalled();
  });
  it("enforces authentication, project scope and write budget; any working agent may heartbeat", async () => {
    expect((await POST(request("", false), context)).status).toBe(401);
    expect((await POST(request(""), context)).status).toBe(400);
    db.project.findFirst.mockResolvedValueOnce(null);
    expect((await POST(request(), context)).status).toBe(404);
    mocks.budget.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 7 });
    const response = await POST(request(), context);
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("7");
    expect(mocks.budget).toHaveBeenCalledWith({ id: "agent", burst: false, burstUntil: null }, "heartbeat");
    expect(db.issueClaim.update).not.toHaveBeenCalled();
  });
  it("hides out-of-scope issues and reports storage failures", async () => {
    db.$queryRaw.mockResolvedValueOnce([]);
    expect((await POST(request(), context)).status).toBe(404);
    db.$queryRaw.mockRejectedValueOnce(new Error("offline"));
    expect((await POST(request(), context)).status).toBe(503);
  });
});

describe("stale claim release", () => {
  it("releases a silent active claim and conditionally reopens its issue atomically with audit and event", async () => {
    expect(await releaseStaleClaims("project")).toEqual({ released: 1 });
    expect(db.issueClaim.update).toHaveBeenCalledWith({ where: { id: "claim" }, data: { status: "released", releasedAt: now, releaseReason: "silence" } });
    expect(db.agentEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      type: "claim.released",
      payload: expect.objectContaining({ claimId: "claim", issueId: "issue", projectId: "project", beneficiaryUserId: "owner", reason: "silence" }),
    }) }));
    expect(db.bug.updateMany).toHaveBeenCalledWith({ where: { id: "issue", projectId: "project", tenantId: "tenant", isDeleted: false, assigneeId: "owner", status: "in_progress", pullRequestUrl: null }, data: { assigneeId: null, status: "open" } });
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "claim.released", agentId: "agent", actorUserId: "admin", bugId: "issue", payload: { claimId: "claim", reason: "silence", projectId: "project" } }) });
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.issueClaim.findFirst.mock.invocationCallOrder[0]);
  });
  it("does not release a silent claim whose fix is already linked (#551)", async () => {
    db.issueClaim.findFirst.mockResolvedValueOnce({ ...claim, bug: { pullRequestUrl: "https://github.com/o/r/pull/1", project: { ownerWaitCapMinutes: null } } });
    expect(await releaseStaleClaims("project")).toEqual({ released: 0 });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
    expect(db.bug.updateMany).not.toHaveBeenCalled();
    expect(db.agentEvent.create).not.toHaveBeenCalled();
  });
  it.each([cutoff, new Date(cutoff.getTime() + 1), now])("keeps a heartbeat at or after the 15-minute boundary (%s)", async (lastHeartbeatAt) => {
    db.issueClaim.findFirst.mockResolvedValueOnce({ ...claim, lastHeartbeatAt });
    expect(await releaseStaleClaims("project")).toEqual({ released: 0 });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
    expect(db.agentEvent.create).not.toHaveBeenCalled();
  });
  it("publishes no event and no audit row when nothing was stale", async () => {
    db.issueClaim.findMany.mockResolvedValue([{ id: "claim", bugId: "issue", bug: { tenantId: "tenant", projectId: "project" } }]);
    db.issueClaim.findFirst.mockResolvedValueOnce({ ...claim, lastHeartbeatAt: now });
    expect(await sweepStaleClaims()).toEqual({ released: 0, offered: 0 });
    expect(db.agentEvent.create).not.toHaveBeenCalled();
    expect(db.agentAuditEvent.create).not.toHaveBeenCalled();
  });
  it("starts the clock at activation when no heartbeat exists, never the offer time", async () => {
    db.issueClaim.findFirst.mockResolvedValueOnce({ ...claim, lastHeartbeatAt: null, claimedAt: cutoff, offeredAt: stale });
    expect(await releaseStaleClaims("project")).toEqual({ released: 0 });
    db.issueClaim.findFirst.mockResolvedValueOnce({ ...claim, lastHeartbeatAt: null });
    expect(await releaseStaleClaims("project")).toEqual({ released: 1 });
    db.issueClaim.findFirst.mockResolvedValueOnce({ ...claim, lastHeartbeatAt: null, claimedAt: null, createdAt: stale });
    expect(await releaseStaleClaims("project")).toEqual({ released: 0 });
  });
  it("releases an undelivered claim past deliverBy even while the agent heartbeats (#593)", async () => {
    db.membership.findMany.mockResolvedValue([{ userId: "next-owner", user: { agents: [{ id: "agent-next" }] } }]);
    db.issueClaim.findFirst.mockResolvedValueOnce({
      ...claim,
      lastHeartbeatAt: now,
      deliverBy: new Date(now.getTime() - 1),
      bug: { pullRequestUrl: null },
    });
    // The locked re-read sees the claim; the re-offer's existing-offer probe sees none.
    db.issueClaim.findFirst.mockResolvedValueOnce(null);
    expect(await releaseStaleClaims("project")).toEqual({ released: 1 });
    // The reopened issue is offered to someone else, never straight back.
    expect(db.issueClaim.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ bugId: "issue", beneficiaryUserId: "next-owner", status: "offered" }),
    }));
    expect(db.agentEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "claim.offered" }) }));
    expect(db.issueClaim.update).toHaveBeenCalledWith({
      where: { id: "claim" },
      data: { status: "released", releasedAt: now, releaseReason: "deadline" },
    });
    expect(db.agentEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      type: "claim.released",
      payload: expect.objectContaining({ reason: "deadline", claimId: "claim" }),
    }) }));
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "claim.released",
      payload: { claimId: "claim", reason: "deadline", projectId: "project" },
    }) });
  });

  it("counts the deadline boundary as overdue but leaves one millisecond after it alone", async () => {
    db.issueClaim.findFirst.mockResolvedValueOnce({
      ...claim, lastHeartbeatAt: now, deliverBy: now, bug: { pullRequestUrl: null },
    });
    expect(await releaseStaleClaims("project")).toEqual({ released: 1 });
    db.issueClaim.update.mockClear();
    db.issueClaim.findFirst.mockResolvedValueOnce({
      ...claim, lastHeartbeatAt: now, deliverBy: new Date(now.getTime() + 1), bug: { pullRequestUrl: null },
    });
    expect(await releaseStaleClaims("project")).toEqual({ released: 0 });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
  });

  it("keeps an overdue claim whose fix is already linked", async () => {
    db.issueClaim.findFirst.mockResolvedValueOnce({
      ...claim,
      lastHeartbeatAt: now,
      deliverBy: new Date(now.getTime() - 1),
      bug: { pullRequestUrl: "https://github.com/o/r/pull/1" },
    });
    expect(await releaseStaleClaims("project")).toEqual({ released: 0 });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
  });

  it("limits candidates to stale active claims in the project, excluding offers", async () => {
    await releaseStaleClaims("project");
    expect(db.issueClaim.findMany).toHaveBeenCalledWith({ where: { status: "active", releasedAt: null, waitingOnOwnerSince: null, bug: { projectId: "project", tenantId: "tenant", isDeleted: false, status: "in_progress" }, OR: [{ lastHeartbeatAt: { lt: cutoff }, bug: { pullRequestUrl: null } }, { lastHeartbeatAt: null, claimedAt: { lt: cutoff }, bug: { pullRequestUrl: null } }, { deliverBy: { lt: now }, bug: { pullRequestUrl: null } }] }, select: { id: true, bugId: true } });
    expect(db.issueClaim.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        bug: { projectId: "project", tenantId: "tenant", isDeleted: false, status: "in_progress" },
      }),
    }));
  });
  it("skips a candidate if its issue was resolved before the locked re-read", async () => {
    db.issueClaim.findFirst.mockResolvedValueOnce(null);
    expect(await releaseStaleClaims("project")).toEqual({ released: 0 });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
  });
  it("preserves a newer claim and skips claims already released by another sweep", async () => {
    db.issueClaim.count.mockResolvedValueOnce(1);
    expect(await releaseStaleClaims("project")).toEqual({ released: 1 });
    expect(db.bug.updateMany).not.toHaveBeenCalled();
    expect(db.issueClaim.create).not.toHaveBeenCalled();
    db.issueClaim.findFirst.mockResolvedValueOnce(null);
    expect(await releaseStaleClaims("project")).toEqual({ released: 0 });
  });
  it("requires super-admin authorization before reading claims", async () => {
    mocks.admin.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(releaseStaleClaims("project")).rejects.toThrow("Forbidden");
    expect(db.project.findUnique).not.toHaveBeenCalled();
    expect(db.issueClaim.findMany).not.toHaveBeenCalled();
  });
  it("rejects an unknown project without a sweep", async () => {
    db.project.findUnique.mockResolvedValueOnce(null);
    await expect(releaseStaleClaims("missing")).rejects.toMatchObject({ status: 404 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("propagates audit failure so the transaction rolls back", async () => {
    db.agentAuditEvent.create.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(releaseStaleClaims("project")).rejects.toThrow("audit unavailable");
  });
});

describe("scheduled stale-claim sweep (#524)", () => {
  it("releases stale claims across every project, publishing and re-offering each", async () => {
    db.issueClaim.findMany.mockResolvedValue([
      { id: "claim", bugId: "issue", bug: { tenantId: "tenant", projectId: "project" } },
      { id: "claim-2", bugId: "issue-2", bug: { tenantId: "tenant", projectId: "project-2" } },
    ]);
    db.issueClaim.findFirst
      .mockResolvedValueOnce({ ...claim, bugId: "issue-2" })
      .mockResolvedValueOnce({ ...claim });
    expect(await sweepStaleClaims()).toEqual({ released: 2, offered: 0 });
    // The scheduler acts without a person, so the sweep's audit row has no actor user.
    const sweeps = db.agentAuditEvent.create.mock.calls.filter(([call]) => call.data.action === "claim.released");
    for (const [call] of sweeps) expect(call.data.actorUserId).toBeNull();
    expect(db.issueClaim.findMany).toHaveBeenCalledWith({ where: { status: "active", releasedAt: null, waitingOnOwnerSince: null,
      bug: { isDeleted: false, status: "in_progress" },
      OR: [{ lastHeartbeatAt: { lt: cutoff }, bug: { pullRequestUrl: null } }, { lastHeartbeatAt: null, claimedAt: { lt: cutoff }, bug: { pullRequestUrl: null } }, { deliverBy: { lt: now }, bug: { pullRequestUrl: null } }] },
      orderBy: { createdAt: "asc" }, take: 50,
      select: { id: true, bugId: true, bug: { select: { tenantId: true, projectId: true } } } });
  });
  it("rewrites the released issue to open and offers it to the next eligible agent", async () => {
    db.issueClaim.findFirst.mockResolvedValueOnce(claim).mockResolvedValueOnce(null);
    db.membership.findMany.mockResolvedValue([{ userId: "next-owner", user: { agents: [{ id: "agent-next" }] } }]);
    expect(await sweepStaleClaims()).toEqual({ released: 1, offered: 1 });
    const events = db.agentEvent.create.mock.calls.map(([call]) => call.data);
    expect(events.map((event: { type: string }) => event.type)).toEqual(["claim.released", "claim.offered"]);
    expect(events[0].payload).toEqual({ claimId: "claim", issueId: "issue", projectId: "project", beneficiaryUserId: "owner", reason: "silence" });
    expect(mocks.notifyLater).toHaveBeenCalledWith(expect.objectContaining({
      kind: "claim_offered", claimId: "claim-next", bugId: "issue", bugTitle: "Bug", recipientId: "next-owner",
    }));
  });
  it("does not offer when a human reassigned or resolved the issue meanwhile", async () => {
    db.bug.updateMany.mockResolvedValue({ count: 0 });
    db.bug.findFirst.mockResolvedValue({ id: "issue", projectId: "project", title: "Bug", assigneeId: "someone-else", status: "in_progress" });
    expect(await sweepStaleClaims()).toEqual({ released: 1, offered: 0 });
    expect(db.issueClaim.create).not.toHaveBeenCalled();
  });
  it("does not offer when the reopened issue cannot be offered to anyone", async () => {
    db.bug.findFirst.mockResolvedValue({ id: "issue", projectId: "project", title: "Bug", assigneeId: null, status: "open" });
    db.issueClaim.create.mockRejectedValueOnce(new Error("should not reach claim creation with no candidates"));
    expect(await sweepStaleClaims()).toEqual({ released: 1, offered: 0 });
    expect(db.issueClaim.create).not.toHaveBeenCalled();
  });
});

describe("claims waiting on the owner's answer (#606)", () => {
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  function waiting(since: Date, cap = 240) {
    return { id: "claim", bugId: "issue", agentId: "agent", waitingOnOwnerSince: since,
      bug: { tenantId: "tenant", projectId: "project", project: { ownerWaitCapMinutes: cap } } };
  }
  function freshWaiting(since: Date, cap = 240) {
    return { ...claim, waitingOnOwnerSince: since, deliverBy: minutesAgo(60),
      bug: { pullRequestUrl: null, project: { ownerWaitCapMinutes: cap } } };
  }

  it("leaves waiting claims out of the silence and deadline query", async () => {
    db.issueClaim.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await sweepStaleClaims();
    expect(db.issueClaim.findMany.mock.calls[0][0].where.waitingOnOwnerSince).toBeNull();
    expect(db.issueClaim.findMany.mock.calls[1][0].where).toMatchObject({ status: "active", releasedAt: null, waitingOnOwnerSince: { not: null } });
  });

  it("keeps a silent, overdue claim while its agent waits, up to the cap", async () => {
    db.issueClaim.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([waiting(minutesAgo(239))]);
    db.agentQuestion.findFirst.mockResolvedValue(null);
    expect(await sweepStaleClaims()).toEqual({ released: 0, offered: 0 });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
    expect(db.agentEvent.create).not.toHaveBeenCalled();
  });

  it("does not release a claim that started waiting after it was picked as stale", async () => {
    db.issueClaim.findMany.mockResolvedValueOnce([{ id: "claim", bugId: "issue", bug: { tenantId: "tenant", projectId: "project" } }]).mockResolvedValueOnce([]);
    db.issueClaim.findFirst.mockResolvedValueOnce(freshWaiting(minutesAgo(1)));
    expect(await sweepStaleClaims()).toEqual({ released: 0, offered: 0 });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
  });

  it("releases at the cap for owner_unresponsive, without a reputation penalty", async () => {
    db.issueClaim.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([waiting(minutesAgo(240))]);
    db.issueClaim.findFirst.mockResolvedValueOnce(freshWaiting(minutesAgo(240)));
    expect(await sweepStaleClaims()).toEqual({ released: 1, offered: 0 });
    expect(db.issueClaim.update).toHaveBeenCalledWith({ where: { id: "claim" }, data: { status: "released", releasedAt: now, releaseReason: "owner_unresponsive" } });
    expect(db.agentEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      type: "claim.released", payload: expect.objectContaining({ reason: "owner_unresponsive" }) }) }));
  });

  it("uses the project's cap", async () => {
    db.issueClaim.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([waiting(minutesAgo(61), 60)]);
    db.issueClaim.findFirst.mockResolvedValueOnce(freshWaiting(minutesAgo(61), 60));
    expect(await sweepStaleClaims()).toEqual({ released: 1, offered: 0 });
    expect(db.issueClaim.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ releaseReason: "owner_unresponsive" }) }));
  });

  it("reminds the owner once the question is 30 minutes old, and only once", async () => {
    db.issueClaim.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([waiting(minutesAgo(31))]);
    db.agentQuestion.findFirst.mockResolvedValueOnce({ id: "q1", body: "Which API?", ownerUserId: "owner",
      agent: { name: "Agent", tenantId: "tenant" }, bug: { title: "Bug" } });
    db.agentQuestion.updateMany.mockResolvedValueOnce({ count: 1 });
    await sweepStaleClaims();
    expect(db.agentQuestion.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { agentId: "agent", bugId: "issue", answeredAt: null, remindedAt: null, createdAt: { lte: minutesAgo(30) } } }));
    expect(db.agentQuestion.updateMany).toHaveBeenCalledWith({ where: { id: "q1", remindedAt: null }, data: { remindedAt: now } });
    expect(mocks.notifyLater).toHaveBeenCalledWith(expect.objectContaining({
      kind: "agent_question", questionId: "q1", recipientId: "owner", reminder: true, bugId: "issue" }));

    // Another sweep won the race to remind: no second notification.
    mocks.notifyLater.mockClear();
    db.issueClaim.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([waiting(minutesAgo(31))]);
    db.agentQuestion.findFirst.mockResolvedValueOnce({ id: "q1", body: "Which API?", ownerUserId: "owner",
      agent: { name: "Agent", tenantId: "tenant" }, bug: { title: "Bug" } });
    db.agentQuestion.updateMany.mockResolvedValueOnce({ count: 0 });
    await sweepStaleClaims();
    expect(mocks.notifyLater).not.toHaveBeenCalled();
  });
});
