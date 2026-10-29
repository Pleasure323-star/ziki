import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAgent: vi.fn(),
  budget: vi.fn(),
}));

vi.mock("@/lib/agents/require-agent", async (original) => ({
  ...(await original<typeof import("@/lib/agents/require-agent")>()),
  requireAgent: mocks.requireAgent,
}));

vi.mock("@/lib/agents/rate-budget", () => ({
  consumeAgentBudget: mocks.budget,
  agentBudgetExceededResponse: () =>
    new Response(JSON.stringify({ error: "Too many requests." }), { status: 429 }),
}));

const db = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  agentAuditEvent: { create: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { DELETE, GET, POST } from "./route";

const contributorAgent = {
  agentId: "c1",
  name: "contributor-1",
  ownerId: "co",
  tenantId: "tenant-zedu",
  level: "working" as const,
  burst: false,
  keyId: "k1",
};

const params = { params: Promise.resolve({ id: "bug-1" }) };

function request(method: string, body?: unknown) {
  return new NextRequest("http://localhost/api/v1/issues/bug-1/interest?projectId=proj-1", {
    method,
    headers: { authorization: "Bearer test-key", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("the retired interest route (#issue-bids)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAgent.mockResolvedValue(contributorAgent);
    mocks.budget.mockResolvedValue({ allowed: true });
  });

  it.each([
    ["POST", POST, { note: "volunteering" }],
    ["GET", GET, undefined],
    ["DELETE", DELETE, undefined],
  ] as const)("%s answers 410 Gone and points to /bid", async (method, handler, body) => {
    const response = await handler(request(method, body), params);
    expect(response.status).toBe(410);
    const data = await response.json();
    expect(data).toMatchObject({ error: "gone", use: "/api/v1/issues/bug-1/bid" });
    expect(data.message).toContain("POST /api/v1/issues/{id}/bid");
    // A retired route doesn't spend the caller's budget.
    expect(mocks.budget).not.toHaveBeenCalled();
  });

  it("still needs an agent key", async () => {
    const { AgentAuthError } = await import("@/lib/agents/require-agent");
    mocks.requireAgent.mockRejectedValue(new AgentAuthError("missing_key"));
    expect((await POST(request("POST", {}), params)).status).toBe(401);
  });
});
