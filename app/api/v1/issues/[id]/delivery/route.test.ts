import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAgent: vi.fn(),
  budget: vi.fn(),
  clientForInstallation: vi.fn(),
  standingAcceptance: vi.fn(),
}));

vi.mock("@/lib/agents/require-agent", async (original) => ({
  ...(await original<typeof import("@/lib/agents/require-agent")>()),
  requireAgent: mocks.requireAgent,
}));
vi.mock("@/lib/agents/rate-budget", async (original) => ({
  ...(await original<typeof import("@/lib/agents/rate-budget")>()),
  consumeAgentBudget: mocks.budget,
}));
vi.mock("@/lib/github/merge-pr", async (original) => ({
  ...(await original<typeof import("@/lib/github/merge-pr")>()),
  clientForInstallation: mocks.clientForInstallation,
  standingAcceptance: mocks.standingAcceptance,
}));
vi.mock("@/lib/agent-api/review-offer", () => ({ createReviewOffers: vi.fn().mockResolvedValue(null) }));

const db = vi.hoisted(() => ({
  bug: { findFirst: vi.fn(), update: vi.fn() },
  issueClaim: { findFirst: vi.fn() },
  reviewOffer: { findFirst: vi.fn() },
  delivery: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  testVerdict: { updateMany: vi.fn() },
  bugActivity: { create: vi.fn() },
  agentAuditEvent: { create: vi.fn() },
  agentEvent: { create: vi.fn() },
  webhookSubscription: { findMany: vi.fn() },
  webhookDelivery: { createMany: vi.fn() },
  project: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { GET, POST } from "./route";

const agent = { agentId: "c1", name: "c1", ownerId: "co", tenantId: "tenant", level: "working", burst: false, keyId: "k" };
const params = { params: Promise.resolve({ id: "bug1" }) };
const PR_URL = "https://github.com/zedu/web/pull/7";
const body = { pullRequestUrl: PR_URL, summary: "Fixed the overlap.", description: "Wrapped the header; added a layout test.", testResults: "42 passed" };

function request(payload: unknown, method = "POST", query = "") {
  return new NextRequest(`http://localhost/api/v1/issues/bug1/delivery${query}`, {
    method,
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
  });
}

const bug = (overrides: Record<string, unknown> = {}) => ({
  id: "bug1",
  projectId: "proj-1",
  status: "in_progress",
  pullRequestUrl: null,
  project: { repoUrl: "https://github.com/zedu/web", githubInstallationId: null },
  ...overrides,
});

const storedDelivery = {
  id: "dlv1",
  agentId: "c1",
  beneficiaryUserId: "co",
  summary: body.summary,
  description: body.description,
  pullRequestUrl: PR_URL,
  headSha: null,
  screenshots: [],
  testResults: "42 passed",
  createdAt: new Date("2026-10-30T10:00:00Z"),
  updatedAt: new Date("2026-10-30T10:00:00Z"),
  agent: { name: "Ada's Claude" },
  beneficiary: { name: "Ada" },
  replies: [],
};

describe("POST /api/v1/issues/{id}/delivery (#delivered-step)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
    mocks.requireAgent.mockResolvedValue(agent);
    mocks.budget.mockResolvedValue({ allowed: true });
    mocks.clientForInstallation.mockReturnValue(null);
    mocks.standingAcceptance.mockResolvedValue(null);
    db.bug.findFirst.mockResolvedValue(bug());
    db.bug.update.mockResolvedValue({});
    db.issueClaim.findFirst.mockResolvedValue({ id: "claim-1", beneficiaryUserId: "co" });
    db.reviewOffer.findFirst.mockResolvedValue(null);
    db.delivery.findUnique.mockResolvedValue(null);
    db.delivery.create.mockResolvedValue({ id: "dlv1" });
    db.delivery.update.mockResolvedValue({ id: "dlv1" });
    db.delivery.findMany.mockResolvedValue([storedDelivery]);
    db.testVerdict.updateMany.mockResolvedValue({ count: 0 });
    db.bugActivity.create.mockResolvedValue({});
    db.agentAuditEvent.create.mockResolvedValue({});
    db.agentEvent.create.mockResolvedValue({ id: "event-1" });
    db.webhookSubscription.findMany.mockResolvedValue([]);
  });

  it("records the delivery and moves the issue to Delivered, with an issue.delivered event", async () => {
    const response = await POST(request(body), params);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ replaced: false, delivery: { id: "dlv1", summary: body.summary, current: true, by: "Ada" } });
    expect(db.delivery.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ bugId: "bug1", agentId: "c1", beneficiaryUserId: "co", summary: body.summary, pullRequestUrl: PR_URL, testResults: "42 passed" }),
    }));
    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { pullRequestUrl: PR_URL, pullRequestHeadSha: null, status: "delivered" } });
    expect(db.bugActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "status_changed", metadata: expect.objectContaining({ from: "in_progress", to: "delivered", deliveryId: "dlv1" }) }),
    });
    expect(db.agentEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "issue.delivered" }) }));
  });

  it("replaces the agent's own delivery when it delivers again", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ status: "done", pullRequestUrl: PR_URL }));
    db.delivery.findUnique.mockResolvedValue({ id: "dlv1" });
    const response = await POST(request(body), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replaced: true });
    expect(db.delivery.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "dlv1" } }));
    expect(db.bug.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "delivered" }) }));
  });

  it("needs a summary, a description and evidence", async () => {
    for (const payload of [
      { pullRequestUrl: PR_URL, description: "d", testResults: "ok" },
      { pullRequestUrl: PR_URL, summary: "s", testResults: "ok" },
      { pullRequestUrl: PR_URL, summary: "s", description: "d" },
    ]) {
      const response = await POST(request(payload), params);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("invalid_request");
    }
    expect(db.delivery.create).not.toHaveBeenCalled();
  });

  it("is only for the agent holding the claim", async () => {
    db.issueClaim.findFirst.mockResolvedValue(null);
    const response = await POST(request(body), params);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("no_claim");
    expect(db.delivery.create).not.toHaveBeenCalled();
  });

  it("lets an accepted review-offer holder deliver when nothing is delivered yet (#539)", async () => {
    db.issueClaim.findFirst.mockResolvedValue(null);
    db.reviewOffer.findFirst.mockResolvedValue({ id: "offer-1" });
    expect((await POST(request(body), params)).status).toBe(201);
    db.bug.findFirst.mockResolvedValue(bug({ pullRequestUrl: "https://github.com/zedu/web/pull/3" }));
    expect((await POST(request(body), params)).status).toBe(409);
  });

  it("is refused before the work is taken or once it is live", async () => {
    for (const status of ["requires_confirmation", "open", "resolved", "closed"]) {
      db.bug.findFirst.mockResolvedValueOnce(bug({ status }));
      const response = await POST(request(body), params);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("not_in_progress");
    }
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("refuses a pull request outside the project's repository, or not a pull request at all", async () => {
    expect((await POST(request({ ...body, pullRequestUrl: "https://github.com/other/repo/pull/1" }), params)).status).toBe(422);
    expect((await POST(request({ ...body, pullRequestUrl: "https://example.com/x" }), params)).status).toBe(400);
  });

  it("keeps an accepted fix bound to its pull request (#489)", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ status: "ready_to_merge", pullRequestUrl: "https://github.com/zedu/web/pull/3" }));
    mocks.standingAcceptance.mockResolvedValue({ headSha: "abc" });
    const response = await POST(request(body), params);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("accepted_pull_request");
  });

  it("refuses a closed, merged or empty pull request, and records the head commit of an open one (#255, #713, #489)", async () => {
    const client = { getPullRequest: vi.fn() };
    mocks.clientForInstallation.mockReturnValue(client);
    db.bug.findFirst.mockResolvedValue(bug({ project: { repoUrl: "https://github.com/zedu/web", githubInstallationId: 5 } }));
    for (const [pullRequest, error] of [
      [{ state: "closed", merged: false }, "pull_request_closed"],
      [{ state: "closed", merged: true }, "pull_request_merged"],
      [{ state: "open", merged: false, changedFiles: 0 }, "pull_request_empty"],
    ] as const) {
      client.getPullRequest.mockResolvedValueOnce(pullRequest);
      const response = await POST(request(body), params);
      expect(response.status).toBe(422);
      expect((await response.json()).error).toBe(error);
    }
    client.getPullRequest.mockResolvedValueOnce({ state: "open", merged: false, changedFiles: 3, headSha: "fresh-sha" });
    expect((await POST(request(body), params)).status).toBe(201);
    expect(db.bug.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ pullRequestHeadSha: "fresh-sha" }) }));
  });
});

describe("GET /api/v1/issues/{id}/delivery", () => {
  it("lists the issue's deliveries with their replies, marking the current one", async () => {
    vi.clearAllMocks();
    mocks.requireAgent.mockResolvedValue(agent);
    mocks.budget.mockResolvedValue({ allowed: true });
    db.project.findFirst.mockResolvedValue({ id: "proj-1" });
    db.bug.findFirst.mockResolvedValue({ id: "bug1", number: 7, status: "delivered", pullRequestUrl: PR_URL });
    db.delivery.findMany.mockResolvedValue([storedDelivery]);
    const response = await GET(request(null, "GET", "?projectId=proj-1"), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ issueNumber: 7, status: "delivered", deliveries: [{ id: "dlv1", current: true, agentName: "Ada's Claude", by: "Ada" }] });
  });
});
