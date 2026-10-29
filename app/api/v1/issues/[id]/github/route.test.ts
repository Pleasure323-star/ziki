import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAgent: vi.fn(),
  budget: vi.fn(),
  merge: vi.fn(),
  clientForInstallation: vi.fn(),
  standingAcceptance: vi.fn(),
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
vi.mock("@/lib/github/merge-pr", async (original) => ({
  ...(await original<typeof import("@/lib/github/merge-pr")>()),
  mergeAcceptedFix: mocks.merge,
  clientForInstallation: mocks.clientForInstallation,
  standingAcceptance: mocks.standingAcceptance,
}));

const db = vi.hoisted(() => ({
  bug: { findFirst: vi.fn(), update: vi.fn() },
  issueClaim: { findFirst: vi.fn() },
  reviewOffer: { findFirst: vi.fn() },
  testVerdict: { updateMany: vi.fn() },
  bugActivity: { create: vi.fn() },
  agentAuditEvent: { create: vi.fn() },
  agentEvent: { create: vi.fn() },
  webhookSubscription: { findMany: vi.fn() },
  webhookDelivery: { createMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { AgentAuthError } from "@/lib/agents/require-agent";
import { POST } from "./route";

const agent = {
  agentId: "c1",
  name: "c1",
  ownerId: "co",
  tenantId: "tenant",
  level: "working",
  burst: false,
  keyId: "k",
};
const params = { params: Promise.resolve({ id: "bug1" }) };
const PR_URL = "https://github.com/zedu/web/pull/7";

function request(body: unknown, key = true, issueId = "bug1") {
  const payload =
    body && typeof body === "object" && !Array.isArray(body) && "pullRequestUrl" in body && !("screenshots" in body) && !("testResults" in body)
      ? { ...body, testResults: "passes vitest" }
      : body;
  return new NextRequest(`http://localhost/api/v1/issues/${issueId}/github`, {
    method: "POST",
    headers: {
      ...(key ? { authorization: "Bearer test-key" } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/v1/issues/[id]/github (#452)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
    mocks.requireAgent.mockResolvedValue(agent);
    mocks.budget.mockResolvedValue({ allowed: true });
    mocks.merge.mockResolvedValue({
      status: 200,
      merged: true,
      mergeCommitSha: "merge-sha",
      pullRequestUrl: PR_URL,
    });
    mocks.clientForInstallation.mockReturnValue(null);
    mocks.standingAcceptance.mockResolvedValue(null);
    db.bug.findFirst.mockResolvedValue({
      id: "bug1",
      projectId: "proj-1",
      pullRequestUrl: null,
      project: { repoUrl: "https://github.com/zedu/web", githubInstallationId: null },
    });
    db.bug.update.mockResolvedValue({});
    db.issueClaim.findFirst.mockResolvedValue({ id: "claim-1" });
    db.reviewOffer.findFirst.mockResolvedValue(null);
    db.testVerdict.updateMany.mockResolvedValue({ count: 0 });
    db.bugActivity.create.mockResolvedValue({});
    db.agentAuditEvent.create.mockResolvedValue({});
    db.agentEvent.create.mockResolvedValue({ id: "event-1" });
    db.webhookSubscription.findMany.mockResolvedValue([]);
  });

  it("links the pull request and merges once the fix is accepted", async () => {
    const response = await POST(request({ pullRequestUrl: PR_URL }), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ linked: true, merged: true, mergeCommitSha: "merge-sha" });
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "bug1" },
      data: { pullRequestUrl: PR_URL, pullRequestHeadSha: null, reviewStatus: "submitted" },
    });
    expect(db.bugActivity.create).toHaveBeenCalledWith({
      data: {
        bugId: "bug1",
        actorId: agent.ownerId,
        type: "edited",
        summary: `linked PR ${PR_URL} with test results`,
        metadata: {
          field: "pullRequestUrl",
          pullRequestUrl: PR_URL,
          testResults: "passes vitest",
        },
      },
    });
    expect(db.agentEvent.create).toHaveBeenCalledWith({
      data: {
        tenantId: agent.tenantId,
        type: "issue.pr_linked",
        payload: {
          issueId: "bug1",
          projectId: "proj-1",
          pullRequestUrl: PR_URL,
          agentId: agent.agentId,
          testResults: "passes vitest",
        },
        actorAgentId: agent.agentId,
        bugId: "bug1",
      },
      select: { id: true },
    });
    expect(mocks.merge).toHaveBeenCalledWith(agent, "bug1");
    expect(mocks.budget).toHaveBeenCalledWith({ id: "c1", burst: false, burstUntil: null }, "write");
  });

  it("rejects submissions without screenshots or test results", async () => {
    const rawReq = new NextRequest("http://localhost/api/v1/issues/bug1/github", {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({ pullRequestUrl: PR_URL }),
    });
    const response = await POST(rawReq, params);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Include screenshots of the fix or test results demonstrating the fix with your pull request submission.",
    });
  });

  it.each(["42", "ZE-42"])("resolves issue reference %s before linking the pull request", async (issueId) => {
    const response = await POST(request({ pullRequestUrl: PR_URL }, true, issueId), {
      params: Promise.resolve({ id: issueId }),
    });

    expect(response.status).toBe(200);
    expect(db.bug.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { number: 42, tenantId: agent.tenantId, isDeleted: false },
    }));
    expect(db.issueClaim.findFirst).toHaveBeenCalledWith({
      where: { bugId: "bug1", agentId: agent.agentId, status: "active", releasedAt: null },
      select: { id: true },
    });
    expect(mocks.merge).toHaveBeenCalledWith(agent, "bug1");
  });

  it("refuses to link a pull request when this agent has no active claim", async () => {
    db.issueClaim.findFirst.mockResolvedValue(null);
    const response = await POST(request({ pullRequestUrl: PR_URL }), params);
    expect(response.status).toBe(409);
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("lets an accepted review-offer holder link the pull request when none is linked (#539)", async () => {
    db.issueClaim.findFirst.mockResolvedValue(null);
    db.reviewOffer.findFirst.mockResolvedValue({ id: "offer-1" });
    mocks.merge.mockResolvedValue({ status: 409, merged: false, reason: "not_accepted", message: "no" });

    const response = await POST(request({ pullRequestUrl: PR_URL }), params);

    expect(response.status).toBe(200);
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "bug1" },
      data: { pullRequestUrl: PR_URL, pullRequestHeadSha: null, reviewStatus: "submitted" },
    });
  });

  it("does not let a review-offer holder replace an already linked pull request (#539)", async () => {
    db.issueClaim.findFirst.mockResolvedValue(null);
    db.reviewOffer.findFirst.mockResolvedValue({ id: "offer-1" });
    db.bug.findFirst.mockResolvedValue({
      id: "bug1",
      pullRequestUrl: PR_URL,
      project: { repoUrl: "https://github.com/zedu/web", githubInstallationId: null },
    });
    mocks.standingAcceptance.mockResolvedValue(null);

    const response = await POST(
      request({ pullRequestUrl: "https://github.com/zedu/web/pull/999" }),
      params,
    );

    expect(response.status).toBe(409);
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("re-attributes verdicts recorded before the pull request was linked (#539)", async () => {
    mocks.merge.mockResolvedValue({ status: 409, merged: false, reason: "not_accepted", message: "no" });
    const response = await POST(request({ pullRequestUrl: PR_URL }), params);

    expect(response.status).toBe(200);
    expect(db.testVerdict.updateMany).toHaveBeenCalledWith({
      where: { bugId: "bug1", OR: [{ pullRequestUrl: null }, { pullRequestUrl: "" }] },
      data: { pullRequestUrl: PR_URL },
    });
  });

  it("links only, without merging, before the fix is accepted", async () => {
    mocks.merge.mockResolvedValue({ status: 409, merged: false, reason: "not_accepted", message: "nope" });
    const response = await POST(request({ pullRequestUrl: PR_URL }), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ linked: true, merged: false, reason: "not_accepted" });
    expect(db.bug.update).toHaveBeenCalledTimes(1);
  });

  it("rejects a URL that is not a GitHub pull request", async () => {
    const response = await POST(request({ pullRequestUrl: "https://example.com/x" }), params);
    expect(response.status).toBe(400);
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("rejects a pull request outside the project's repository", async () => {
    const response = await POST(
      request({ pullRequestUrl: "https://github.com/someone/fork/pull/7" }),
      params,
    );
    expect(response.status).toBe(422);
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("refuses to swap in a different pull request after the fix was accepted (#489)", async () => {
    db.bug.findFirst.mockResolvedValue({
      id: "bug1",
      pullRequestUrl: PR_URL,
      project: { repoUrl: "https://github.com/zedu/web", githubInstallationId: null },
    });
    mocks.standingAcceptance.mockResolvedValue({ id: "accepted-1", payload: {} });

    const response = await POST(
      request({ pullRequestUrl: "https://github.com/zedu/web/pull/999" }),
      params,
    );

    expect(response.status).toBe(409);
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("allows re-linking the accepted pull request, refreshing its head SHA (#489)", async () => {
    db.bug.findFirst.mockResolvedValue({
      id: "bug1",
      pullRequestUrl: PR_URL,
      project: { repoUrl: "https://github.com/zedu/web", githubInstallationId: "123" },
    });
    mocks.standingAcceptance.mockResolvedValue({ id: "accepted-1", payload: {} });
    mocks.clientForInstallation.mockReturnValue({
      getPullRequest: vi.fn(async () => ({ merged: false, mergeable: true, headSha: "fresh-sha" })),
    });
    mocks.merge.mockResolvedValue({
      status: 409,
      merged: false,
      reason: "head_moved",
      message: "The accepted pull request's head commit changed since acceptance.",
    });

    const response = await POST(request({ pullRequestUrl: PR_URL }), params);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ linked: true, merged: false, reason: "head_moved" });
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "bug1" },
      data: { pullRequestUrl: PR_URL, pullRequestHeadSha: "fresh-sha", reviewStatus: "submitted" },
    });
  });

  it("records the head SHA GitHub reports when linking (#489)", async () => {
    mocks.clientForInstallation.mockReturnValue({
      getPullRequest: vi.fn(async () => ({ merged: false, mergeable: true, headSha: "abc123" })),
    });
    mocks.merge.mockResolvedValue({ status: 409, merged: false, reason: "not_accepted", message: "no" });

    const response = await POST(request({ pullRequestUrl: PR_URL }), params);

    expect(response.status).toBe(200);
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "bug1" },
      data: { pullRequestUrl: PR_URL, pullRequestHeadSha: "abc123", reviewStatus: "submitted" },
    });
  });

  it("still links when GitHub cannot be reached for the head SHA (#489)", async () => {
    mocks.clientForInstallation.mockReturnValue({
      getPullRequest: vi.fn(async () => {
        throw new Error("GitHub down");
      }),
    });
    mocks.merge.mockResolvedValue({ status: 409, merged: false, reason: "not_accepted", message: "no" });

    const response = await POST(request({ pullRequestUrl: PR_URL }), params);

    expect(response.status).toBe(200);
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "bug1" },
      data: { pullRequestUrl: PR_URL, pullRequestHeadSha: null, reviewStatus: "submitted" },
    });
  });

  it("refuses to link a closed pull request (#255)", async () => {
    mocks.clientForInstallation.mockReturnValue({
      getPullRequest: vi.fn(async () => ({ state: "closed", merged: false, mergeable: false, headSha: "abc123" })),
    });

    const response = await POST(request({ pullRequestUrl: PR_URL }), params);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "pull_request_closed" });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("refuses to link a pull request that is already merged (#255)", async () => {
    mocks.clientForInstallation.mockReturnValue({
      getPullRequest: vi.fn(async () => ({ state: "closed", merged: true, mergeable: false, headSha: "abc123" })),
    });

    const response = await POST(request({ pullRequestUrl: PR_URL }), params);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "pull_request_merged" });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("links an open pull request (#255)", async () => {
    mocks.clientForInstallation.mockReturnValue({
      getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: true, headSha: "abc123" })),
    });
    mocks.merge.mockResolvedValue({ status: 409, merged: false, reason: "not_accepted", message: "no" });

    const response = await POST(request({ pullRequestUrl: PR_URL }), params);

    expect(response.status).toBe(200);
    expect(db.bug.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ pullRequestUrl: PR_URL }) }),
    );
  });

  it("refuses to link an empty pull request (Ziki #713)", async () => {
    mocks.clientForInstallation.mockReturnValue({
      getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: true, headSha: "abc123", changedFiles: 0 })),
    });

    const response = await POST(request({ pullRequestUrl: PR_URL }), params);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "pull_request_empty" });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("links a pull request that changes files (Ziki #713)", async () => {
    mocks.clientForInstallation.mockReturnValue({
      getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: true, headSha: "abc123", changedFiles: 3 })),
    });
    mocks.merge.mockResolvedValue({ status: 409, merged: false, reason: "not_accepted", message: "no" });

    const response = await POST(request({ pullRequestUrl: PR_URL }), params);

    expect(response.status).toBe(200);
  });

  it("404s when the issue is not in the agent's tenant", async () => {
    db.bug.findFirst.mockResolvedValue(null);
    const response = await POST(request({ pullRequestUrl: PR_URL }), params);
    expect(response.status).toBe(404);
  });

  it("surfaces a merge failure after linking", async () => {
    mocks.merge.mockResolvedValue({
      status: 409,
      merged: false,
      reason: "checks_failed",
      message: "Checks are not green.",
    });
    const response = await POST(request({ pullRequestUrl: PR_URL }), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ linked: true, merged: false, reason: "checks_failed" });
  });

  it("audits the link and rejects a missing key", async () => {
    await POST(request({ pullRequestUrl: PR_URL }), params);
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "github.linked" }) }),
    );

    mocks.requireAgent.mockRejectedValue(new AgentAuthError("missing_key"));
    const response = await POST(request({ pullRequestUrl: PR_URL }, false), params);
    expect(response.status).toBe(401);
  });

  it("stops when the write budget is spent", async () => {
    mocks.budget.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 });
    const response = await POST(request({ pullRequestUrl: PR_URL }), params);
    expect(response.status).toBe(429);
    expect(mocks.merge).not.toHaveBeenCalled();
  });
});
