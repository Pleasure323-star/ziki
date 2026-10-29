import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({
  requireAgent: vi.fn(), session: vi.fn(), tenant: vi.fn(), project: vi.fn(), read: vi.fn(), audit: vi.fn(), budget: vi.fn(),
}));
vi.mock("@/lib/agents/require-agent", async (original) => ({ ...await original<typeof import("@/lib/agents/require-agent")>(), requireAgent: mocks.requireAgent }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: mocks.session }));
vi.mock("@/lib/tenant-context", () => ({ currentTenantIdFor: mocks.tenant }));
vi.mock("@/lib/agents/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/agents/rate-budget", () => ({ consumeAgentBudget: mocks.budget, agentBudgetExceededResponse: () => new Response(null, { status: 429 }) }));
vi.mock("@/lib/feed", async (original) => ({ ...await original<typeof import("@/lib/feed")>(), feedProject: mocks.project, readFeed: mocks.read }));
import { AgentAuthError } from "@/lib/agents/require-agent";
import { GET } from "./route";

function request(query = "", key = false) {
  return new NextRequest(`http://localhost/api/v1/feed${query}`, { headers: key ? { authorization: "Bearer test-key" } : {} });
}
describe("feed authentication and scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAgent.mockResolvedValue({ agentId: "agent", tenantId: "tenant", level: "working", burst: false });
    mocks.session.mockResolvedValue({ userId: "person" });
    mocks.tenant.mockResolvedValue("tenant");
    mocks.budget.mockResolvedValue({ allowed: true });
    mocks.project.mockResolvedValue({ id: "project" });
    mocks.read.mockResolvedValue({ issues: [], nextCursor: null, hasMore: false });
  });
  it("allows an observer key, charges a read, and audits it", async () => {
    expect((await GET(request("?projectId=project", true))).status).toBe(200);
    expect(mocks.budget).toHaveBeenCalledWith({ id: "agent", burst: false, burstUntil: null }, "read");
    expect(mocks.audit).toHaveBeenCalled();
    expect(mocks.read).toHaveBeenCalledWith("tenant", "project", null, null, 50);
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it("allows a current session", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.tenant).toHaveBeenCalledWith("person");
  });
  it("rejects anonymous callers", async () => {
    mocks.session.mockResolvedValue({ error: "expired" });
    expect((await GET(request())).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("passes a requested limit through to the feed (#469)", async () => {
    expect((await GET(request("?projectId=project&limit=3", true))).status).toBe(200);
    expect(mocks.read).toHaveBeenLastCalledWith("tenant", "project", null, null, 3);
  });

  it("clamps an oversized limit and rejects an unusable one with 422 (#454)", async () => {
    expect((await GET(request("?projectId=project&limit=500", true))).status).toBe(200);
    expect(mocks.read).toHaveBeenLastCalledWith("tenant", "project", null, null, 100);

    for (const raw of ["0", "-5", "abc", "1.5"]) {
      const response = await GET(request(`?projectId=project&limit=${raw}`, true));
      expect(response.status, raw).toBe(422);
      await expect(response.json(), raw).resolves.toMatchObject({ error: expect.stringContaining("limit") });
    }
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
  it("does not fall back to a session for an invalid key", async () => {
    mocks.requireAgent.mockRejectedValue(new AgentAuthError("invalid_key"));
    expect((await GET(request("", true))).status).toBe(401);
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it("rejects a key limited to another project (#742)", async () => {
    mocks.requireAgent.mockResolvedValue({
      agentId: "agent",
      tenantId: "tenant",
      level: "working",
      burst: false,
      projectId: "other",
      projectSlug: "web",
    });
    const response = await GET(request("?projectId=project", true));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "project_forbidden" });
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("rejects missing membership, foreign projects, bad cursors, and exhausted budgets", async () => {
    mocks.tenant.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(403);
    mocks.project.mockResolvedValueOnce(null);
    expect((await GET(request("?projectId=foreign"))).status).toBe(404);
    expect((await GET(request("?after=bad&afterId=x"))).status).toBe(400);
    mocks.budget.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 10 });
    expect((await GET(request("", true))).status).toBe(429);
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
