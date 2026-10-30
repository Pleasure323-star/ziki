import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth-helpers", () => ({
  requireSuperAdmin: vi.fn(),
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
}));

const db = vi.hoisted(() => ({
  agentApiKey: { findUnique: vi.fn() },
  agentAuditEvent: { create: vi.fn() },
  project: { findFirst: vi.fn() },
  issueClaim: { findFirst: vi.fn(), update: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

/**
 * #556: heartbeat must spend its own `heartbeat` budget, never `write`, so an
 * agent that has used up its write budget can still keep its active claims
 * alive. We spy on the real `consumeAgentBudget` (not mock it away) so the
 * test proves the two counters are actually independent, the same way
 * lib/agents/rate-budget.test.ts proves it at the budget-module level.
 */
import { resetRateLimits } from "@/lib/rate-limit";
import { AGENT_RATE_BUDGETS, consumeAgentBudget } from "@/lib/agents/rate-budget";
import { POST as heartbeat } from "./route";

afterEach(() => vi.restoreAllMocks());

const agentRow = {
  id: "agent-a", name: "Agent A", ownerUserId: "owner-a", tenantId: "tenant-a",
  level: "working", burst: false, revokedAt: null,
  owner: { memberships: [{ tenantId: "tenant-a" }] },
};
const context = { params: Promise.resolve({ id: "issue-a" }) };

function request() {
  return new NextRequest("http://localhost/api/v1/issues/issue-a/heartbeat?projectId=project-a", {
    method: "POST",
    headers: { authorization: "Bearer ziki_test-key", "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  resetRateLimits();
  db.agentApiKey.findUnique.mockResolvedValue({ id: "key-a", revokedAt: null, agent: agentRow });
  db.project.findFirst.mockResolvedValue({ id: "project-a" });
  db.$queryRaw.mockResolvedValue([{ id: "issue-a" }]);
  db.issueClaim.findFirst.mockResolvedValue({ id: "claim-a", agentId: "agent-a", status: "active" });
  db.issueClaim.update.mockResolvedValue({ id: "claim-a", lastHeartbeatAt: new Date() });
  db.$transaction.mockImplementation(async (run) => run(db));
});

describe("POST /api/v1/issues/{id}/heartbeat (#556)", () => {
  it("succeeds for an agent that has exhausted its write budget", async () => {
    const now = Date.now();
    // Spend the entire standard write budget directly, the same counter
    // the create/comment/validate routes use.
    for (let i = 0; i < AGENT_RATE_BUDGETS.standard.write.max; i++) {
      const result = await consumeAgentBudget({ id: "agent-a", burst: false, burstUntil: null }, "write", now);
      expect(result.allowed).toBe(true);
    }
    expect((await consumeAgentBudget({ id: "agent-a", burst: false, burstUntil: null }, "write", now)).allowed).toBe(false);

    const response = await heartbeat(request(), context);
    expect(response.status).toBe(200);
    expect(db.issueClaim.update).toHaveBeenCalled();
  });

  it("is charged to its own heartbeat budget, not write", async () => {
    const response = await heartbeat(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("ratelimit-budget")).toBe("heartbeat");
    expect(response.headers.get("ratelimit-limit")).toBe("120");
    // The write budget is untouched by a heartbeat call.
    expect((await consumeAgentBudget({ id: "agent-a", burst: false, burstUntil: null }, "write")).remaining).toBe(AGENT_RATE_BUDGETS.standard.write.max - 1);
  });

  it("honestly reports a 429 with heartbeat's own limit once that budget (not write) is exhausted", async () => {
    const now = Date.now();
    for (let i = 0; i < 120; i++) {
      const result = await consumeAgentBudget({ id: "agent-a", burst: false, burstUntil: null }, "heartbeat", now);
      expect(result.allowed).toBe(true);
    }
    const response = await heartbeat(request(), context);
    expect(response.status).toBe(429);
    expect(response.headers.get("ratelimit-budget")).toBe("heartbeat");
    expect(await response.json()).toMatchObject({ budget: "heartbeat", limit: 120 });
    expect(db.issueClaim.update).not.toHaveBeenCalled();
  });
});
