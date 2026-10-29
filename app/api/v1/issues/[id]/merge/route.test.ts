import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ requireAgent: vi.fn(), budget: vi.fn(), accept: vi.fn() }));
vi.mock("@/lib/agents/require-agent", async (original) => ({
  ...(await original<typeof import("@/lib/agents/require-agent")>()),
  requireAgent: mocks.requireAgent,
}));
vi.mock("@/lib/agents/rate-budget", () => ({
  consumeAgentBudget: mocks.budget,
  agentBudgetExceededResponse: () => new Response(JSON.stringify({ error: "Too many requests." }), { status: 429 }),
}));
vi.mock("@/lib/agent-api/merge", () => ({ acceptFix: mocks.accept }));

import { AgentAuthError } from "@/lib/agents/require-agent";
import { POST } from "./route";

const agent = { agentId: "m1", name: "m1", ownerId: "mo", tenantId: "tenant", level: "manager", burst: false, keyId: "k" };
const params = { params: Promise.resolve({ id: "bug1" }) };

function request(key = true) {
  return new NextRequest("http://localhost/api/v1/issues/bug1/merge", {
    method: "POST",
    headers: key ? { authorization: "Bearer test-key" } : {},
  });
}

describe("POST /api/v1/issues/[id]/merge (#434)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAgent.mockResolvedValue(agent);
    mocks.budget.mockResolvedValue({ allowed: true });
    mocks.accept.mockResolvedValue({ status: 200, accepted: true, solverUserId: "ada", rewardedReviewerUserIds: ["rob", "sam"] });
  });

  it("charges a write and returns the accept summary", async () => {
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, solverUserId: "ada", rewardedReviewerUserIds: ["rob", "sam"] });
    expect(mocks.budget).toHaveBeenCalledWith({ id: "m1", burst: false, burstUntil: null }, "write");
    expect(mocks.accept).toHaveBeenCalledWith(agent, "bug1", {}, {});
  });

  it("passes a reject's written review through and returns it", async () => {
    const review = { id: "rev1", verdict: "reject", summary: "Reject.", description: "Changes requested on PR." };
    mocks.accept.mockResolvedValue({ status: 200, accepted: false, review, replaced: false });
    const body = { verdict: "reject", summary: "Reject.", description: "Changes requested on PR." };
    const req = new NextRequest("http://localhost/api/v1/issues/bug1/merge", {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const response = await POST(req, params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: false, review, replaced: false });
    expect(mocks.accept).toHaveBeenCalledWith(agent, "bug1", {}, body);
  });

  it("maps a bare review's 400 through", async () => {
    mocks.accept.mockResolvedValue({ status: 400, error: "invalid_request", message: "Add a summary.", field: "summary" });
    const response = await POST(request(), params);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request", message: "Add a summary.", field: "summary" });
  });

  it("rejects a missing or bad key", async () => {
    mocks.requireAgent.mockRejectedValue(new AgentAuthError("missing_key"));
    expect((await POST(request(false), params)).status).toBe(401);
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it("stops when the write budget is spent", async () => {
    mocks.budget.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 });
    expect((await POST(request(), params)).status).toBe(429);
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it("maps a failed rule through, naming the condition", async () => {
    mocks.accept.mockResolvedValue({ status: 409, error: "not_ready", missing: "verdicts", message: "Not yet." });
    const response = await POST(request(), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_ready", missing: "verdicts", message: "Not yet." });
  });
});
