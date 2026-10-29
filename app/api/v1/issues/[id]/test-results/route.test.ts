import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ requireAgent: vi.fn(), budget: vi.fn(), submit: vi.fn() }));
vi.mock("@/lib/agents/require-agent", async (original) => ({
  ...(await original<typeof import("@/lib/agents/require-agent")>()),
  requireAgent: mocks.requireAgent,
}));
vi.mock("@/lib/agents/rate-budget", () => ({
  consumeAgentBudget: mocks.budget,
  agentBudgetExceededResponse: () => new Response(JSON.stringify({ error: "Too many requests." }), { status: 429 }),
}));
vi.mock("@/lib/agent-api/test-verdict", () => ({ submitTestVerdict: mocks.submit }));

import { AgentAuthError } from "@/lib/agents/require-agent";
import { POST } from "./route";

const agent = { agentId: "r1", name: "r1", ownerId: "rob", tenantId: "tenant", level: "working", burst: false, keyId: "k" };
const params = { params: Promise.resolve({ id: "bug1" }) };

function request(body: unknown = { goodToMerge: true }, key = true) {
  return new NextRequest("http://localhost/api/v1/issues/bug1/test-results", {
    method: "POST",
    headers: key ? { authorization: "Bearer test-key" } : {},
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/issues/[id]/test-results (#434)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAgent.mockResolvedValue(agent);
    mocks.budget.mockResolvedValue({ allowed: true });
    mocks.submit.mockResolvedValue({ status: 201, verdict: { id: "tv1", goodToMerge: true, summary: "Good to merge.", description: "Tested.", onBehalfOfUserId: "rob" } });
  });

  it("charges a write and returns the verdict", async () => {
    const response = await POST(request(), params);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      verdict: { id: "tv1", goodToMerge: true, summary: "Good to merge.", description: "Tested.", onBehalfOfUserId: "rob" },
    });
    expect(mocks.budget).toHaveBeenCalledWith({ id: "r1", burst: false, burstUntil: null }, "write");
    expect(mocks.submit).toHaveBeenCalledWith(agent, "bug1", { goodToMerge: true });
  });

  it("rejects a missing or bad key", async () => {
    mocks.requireAgent.mockRejectedValue(new AgentAuthError("invalid_key"));
    expect((await POST(request(), params)).status).toBe(401);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("stops when the write budget is spent", async () => {
    mocks.budget.mockResolvedValue({ allowed: false, retryAfterSeconds: 10 });
    expect((await POST(request(), params)).status).toBe(429);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("rejects a non-object body", async () => {
    expect((await POST(request([1, 2, 3]), params)).status).toBe(400);
  });

  it("maps a failed rule through", async () => {
    mocks.submit.mockResolvedValue({ status: 409, error: "already_verdicted", message: "Already done." });
    const response = await POST(request(), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "already_verdicted", message: "Already done." });
  });
});
