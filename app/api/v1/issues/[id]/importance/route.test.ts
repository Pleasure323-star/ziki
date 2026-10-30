import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAgent: vi.fn(), budget: vi.fn(), audit: vi.fn(),
  project: vi.fn(), upvote: vi.fn(), remove: vi.fn(),
}));
vi.mock("@/lib/agents/require-agent", async (original) => ({
  ...(await original<typeof import("@/lib/agents/require-agent")>()),
  requireAgent: mocks.requireAgent,
}));
vi.mock("@/lib/agents/rate-budget", async (original) => ({
  ...(await original<typeof import("@/lib/agents/rate-budget")>()),
  consumeAgentBudget: mocks.budget,
}));
vi.mock("@/lib/agents/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/prisma", () => ({ prisma: { project: { findFirst: mocks.project } } }));
vi.mock("@/lib/agent-api/votes", async (original) => ({
  ...(await original<typeof import("@/lib/agent-api/votes")>()),
  upvoteIssue: mocks.upvote, removeUpvote: mocks.remove,
}));

import * as importance from "./route";

const caller = {
  agentId: "agent", name: "Contributor", ownerId: "owner", tenantId: "tenant",
  level: "working" as const, projectId: "project", burst: false, keyId: "key",
};
const context = { params: Promise.resolve({ id: "bug" }) };
function request(path: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost/api/v1/issues/bug/${path}?projectId=project`, {
    method, ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
  });
}
const reason = { summary: "Blocks every signup.", description: "New users cannot finish signing up, so nothing else matters until this is fixed." };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAgent.mockResolvedValue(caller);
  mocks.budget.mockResolvedValue({ allowed: true });
  mocks.project.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
  mocks.audit.mockResolvedValue(undefined);
  mocks.upvote.mockResolvedValue({ important: true, importance: 3, changed: true, weight: 1 });
  mocks.remove.mockResolvedValue({ important: false, importance: 2, changed: true, weight: 0 });
});

describe("POST/DELETE /issues/{id}/importance (#importance)", () => {
  const route = importance;
  const segment = "importance";

  it("refuses a bare mark with 400", async () => {
    const response = await route.POST(request(segment, "POST"), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "reason_required" });
    expect(mocks.upvote).not.toHaveBeenCalled();
  });

  it("refuses a mark with only a summary", async () => {
    const response = await route.POST(request(segment, "POST", { summary: reason.summary }), context);
    expect(response.status).toBe(400);
    expect(mocks.upvote).not.toHaveBeenCalled();
  });

  it("refuses a summary longer than two sentences", async () => {
    const response = await route.POST(request(segment, "POST", { ...reason, summary: "One. Two. Three." }), context);
    expect(response.status).toBe(400);
  });

  it("records the mark with its reason", async () => {
    const response = await route.POST(request(segment, "POST", reason), context);
    expect(response.status).toBe(201);
    expect(mocks.upvote).toHaveBeenCalledWith(caller, "project", "bug", reason);
    expect(await response.json()).toEqual({
      important: true, importance: 3, changed: true, weight: 1, userId: "owner", agentId: "agent",
      ...reason,
    });
  });

  it("answers 200 when nothing changed", async () => {
    mocks.upvote.mockResolvedValue({ important: true, importance: 3, changed: false, weight: 1 });
    const response = await route.POST(request(segment, "POST", reason), context);
    expect(response.status).toBe(200);
  });

  it("removes the mark without a reason", async () => {
    const response = await route.DELETE(request(segment, "DELETE"), context);
    expect(response.status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith(caller, "project", "bug");
    expect(await response.json()).toEqual({
      important: false, importance: 2, changed: true, userId: "owner",
    });
  });
});
