import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ requireAgent: vi.fn(), budget: vi.fn(), resolve: vi.fn(), project: vi.fn() }));
vi.mock("@/lib/agents/require-agent", async (original) => ({
  ...(await original<typeof import("@/lib/agents/require-agent")>()),
  requireAgent: mocks.requireAgent,
}));
vi.mock("@/lib/agents/rate-budget", () => ({
  consumeAgentBudget: mocks.budget,
  agentBudgetExceededResponse: () => new Response(JSON.stringify({ error: "Too many requests." }), { status: 429 }),
}));
vi.mock("@/lib/agents/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { project: { findFirst: mocks.project } } }));
vi.mock("@/lib/agent-api/resolve", () => ({ resolveMergedFix: mocks.resolve }));

import { POST } from "./route";

const PR = "https://github.com/acme/app/pull/12";
const agent = { agentId: "a1", name: "a1", ownerId: "o1", tenantId: "tenant", level: "working", burst: false, keyId: "k", projectId: null };
const params = { params: Promise.resolve({ id: "bug1" }) };
const PROJECT = "cmvggfa9v003yn72gfxaplftl";

function request(body: unknown, projectId: string | null = PROJECT) {
  return new NextRequest(`http://localhost/api/v1/issues/bug1/resolve${projectId ? `?projectId=${projectId}` : ""}`, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/issues/[id]/resolve (Ziki #515)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAgent.mockResolvedValue(agent);
    mocks.budget.mockResolvedValue({ allowed: true });
    mocks.project.mockResolvedValue({ id: PROJECT });
    mocks.resolve.mockResolvedValue({ status: 200, body: { resolved: true, issueId: "bug1", previousStatus: "open", pullRequestUrl: PR } });
  });

  it.each(["manager", "merger"])("lets a %s agent resolve too", async (level) => {
    mocks.requireAgent.mockResolvedValue({ ...agent, level });
    expect((await POST(request({ pullRequestUrl: PR }), params)).status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });

  it("lets a working agent resolve, charged to the write budget", async () => {
    const response = await POST(request({ pullRequestUrl: PR }), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resolved: true, issueId: "bug1", previousStatus: "open", pullRequestUrl: PR });
    expect(mocks.budget).toHaveBeenCalledWith({ id: "a1", burst: false, burstUntil: null }, "write");
    expect(mocks.resolve).toHaveBeenCalledWith(agent, { tenantId: "tenant", projectId: PROJECT }, "bug1", PR);
  });

  it("passes a refusal through with its status and reason", async () => {
    mocks.resolve.mockResolvedValue({ status: 409, body: { error: "not_merged", message: "That pull request isn't merged yet." } });
    const response = await POST(request({ pullRequestUrl: PR }), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_merged", message: "That pull request isn't merged yet." });
  });

  it.each(["needs_pr_report", "awaiting_release", "pr_broken"])("passes the pull request report's %s refusal through (#pr-reports)", async (error) => {
    mocks.resolve.mockResolvedValue({ status: 409, body: { error, message: "Per the latest report." } });
    const response = await POST(request({ pullRequestUrl: PR }), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error, message: "Per the latest report." });
  });

  it("rejects unknown fields; the pull request may be left out to use the linked one", async () => {
    expect((await POST(request({ pullRequestUrl: PR, status: "resolved" }), params)).status).toBe(400);
    expect(mocks.resolve).not.toHaveBeenCalled();
    await POST(request({}), params);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });

  it("needs a projectId", async () => {
    expect((await POST(request({ pullRequestUrl: PR }, null), params)).status).toBe(400);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("keeps a project-scoped key in its own project (#742)", async () => {
    mocks.requireAgent.mockResolvedValue({ ...agent, projectId: "other-project", projectSlug: "other" });
    expect((await POST(request({ pullRequestUrl: PR }), params)).status).toBe(403);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("stops when the write budget is spent", async () => {
    mocks.budget.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 });
    expect((await POST(request({ pullRequestUrl: PR }), params)).status).toBe(429);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
