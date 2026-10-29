import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAgent: vi.fn(), budget: vi.fn(), audit: vi.fn(),
  project: vi.fn(), transaction: vi.fn(), listBids: vi.fn(), placeBid: vi.fn(), withdrawBid: vi.fn(),
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
vi.mock("@/lib/prisma", () => ({ prisma: {
  project: { findFirst: mocks.project }, $transaction: mocks.transaction,
} }));
vi.mock("@/lib/agent-api/bid", async (original) => ({
  ...(await original<typeof import("@/lib/agent-api/bid")>()),
  listBids: mocks.listBids, placeBid: mocks.placeBid, withdrawBid: mocks.withdrawBid,
}));

import { AgentAuthError } from "@/lib/agents/require-agent";
import { GET, POST } from "./route";

const caller = {
  agentId: "agent", name: "Contributor", ownerId: "owner", tenantId: "tenant",
  level: "working" as const, projectId: "project", burst: false, keyId: "key",
};
const context = { params: Promise.resolve({ id: "587" }) };
function request(method = "GET", body?: unknown, project = "project") {
  return new NextRequest(`http://localhost/api/v1/issues/587/bid?projectId=${project}`, {
    method, ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAgent.mockResolvedValue(caller);
  mocks.budget.mockResolvedValue({ allowed: true });
  mocks.project.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
  mocks.audit.mockResolvedValue(undefined);
  mocks.listBids.mockResolvedValue([]);
  mocks.placeBid.mockResolvedValue({
    bid: { id: "bid", bugId: "canonical-issue", beneficiaryUserId: "owner", summary: "I will fix it.", description: "Plan in full." },
    replaced: false,
  });
});

const bid = { summary: "I will fix it.", description: "Plan in full." };

describe("numeric bid route references (#587)", () => {
  it("passes the numeric reference to the scoped bid reader", async () => {
    mocks.listBids.mockResolvedValue([{
      id: "bid", agentId: "agent", agentName: "Contributor", beneficiaryUserId: "owner", by: "Owner",
      summary: "I will fix it.", description: "Plan in full.", areaMatch: false,
      createdAt: new Date("2026-10-22T12:00:00Z"), updatedAt: new Date("2026-10-22T12:00:00Z"),
      replies: [{ id: "reply", body: "Go ahead.", authorId: "rep", authorName: "Rita", agentId: null, agentName: null, createdAt: new Date("2026-10-22T13:00:00Z"), editedAt: null }],
    }]);
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.listBids).toHaveBeenCalledWith(caller, "project", "587");
    expect(await response.json()).toMatchObject({ bids: [{
      id: "bid", agent_id: "agent", agent_name: "Contributor", summary: "I will fix it.", description: "Plan in full.",
      replies: [{ id: "reply", body: "Go ahead.", author_name: "Rita" }],
    }] });
  });

  it("returns the canonical issue ID after placing a bid by number", async () => {
    const response = await POST(request("POST", bid), context);
    expect(response.status).toBe(201);
    expect(mocks.placeBid).toHaveBeenCalledWith(caller, "project", "587", bid);
    expect(await response.json()).toEqual({
      bid_id: "bid", status: "open", replaced: false, issue_id: "canonical-issue", beneficiary_user_id: "owner",
      summary: "I will fix it.", description: "Plan in full.",
    });
  });

  it("answers 200 when the bid replaced the agent's open bid", async () => {
    mocks.placeBid.mockResolvedValueOnce({
      bid: { id: "bid", bugId: "canonical-issue", beneficiaryUserId: "owner", summary: "New plan.", description: "Different." },
      replaced: true,
    });
    const response = await POST(request("POST", { summary: "New plan.", description: "Different." }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ bid_id: "bid", replaced: true, summary: "New plan." });
  });

  it("authenticates before reading bids", async () => {
    mocks.requireAgent.mockRejectedValue(new AgentAuthError("missing_key"));
    expect((await GET(request(), context)).status).toBe(401);
    expect(mocks.listBids).not.toHaveBeenCalled();
  });

  it("rejects a different project before placing a bid", async () => {
    expect((await POST(request("POST", bid, "other-project"), context)).status).toBe(403);
    expect(mocks.placeBid).not.toHaveBeenCalled();
  });

  it("refuses a bare bid: summary and description are required (#issue-bids)", async () => {
    for (const body of [{}, { summary: "I will fix it." }, { description: "Plan in full." }, { summary: " ", description: "Plan." }]) {
      const response = await POST(request("POST", body), context);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(mocks.placeBid).not.toHaveBeenCalled();
  });

  it("refuses a summary longer than two sentences", async () => {
    const response = await POST(request("POST", { summary: "One. Two. Three.", description: "Plan." }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: "summary", message: "Keep the summary to two sentences." });
    expect(mocks.placeBid).not.toHaveBeenCalled();
  });

  it("says note was replaced when an old client sends one", async () => {
    const response = await POST(request("POST", { note: "Plan" }), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.field).toBe("note");
    expect(body.message).toContain("summary");
    expect(mocks.placeBid).not.toHaveBeenCalled();
  });

  it("returns 503 when the real bid service's database transaction rejects", async () => {
    const { placeBid } = await vi.importActual<typeof import("@/lib/agent-api/bid")>("@/lib/agent-api/bid");
    mocks.placeBid.mockImplementationOnce(placeBid);
    mocks.transaction.mockRejectedValueOnce(new Error("Database unavailable"));

    const response = await POST(request("POST", bid), context);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Bid unavailable; try again." });
  });
});
