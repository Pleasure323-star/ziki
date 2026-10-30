import type { AgentLevel } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REVIEWER_POINTS, reviewerPointsAt } from "@/lib/points/rules";

type VerdictRow = {
  id: string;
  bugId: string;
  goodToMerge: boolean;
  onBehalfOfUserId: string;
  pullRequestUrl: string | null;
  headSha?: string | null;
  createdAt: Date;
  agent: { id: string; ownerUserId: string };
};

const state = vi.hoisted(() => ({
  verdicts: [] as VerdictRow[],
  confirmations: [] as { id: string; bugId: string; verdict: "confirm"; duplicateOfId: null; updatedAt: Date; agentId: string; onBehalfOfUserId: string; agent: { ownerUserId: string } }[],
}));

const db = vi.hoisted(() => ({
  bug: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  bugActivity: { create: vi.fn() },
  comment: { create: vi.fn() },
  testVerdict: { findMany: vi.fn() },
  mergeReview: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  issueConfirmation: { findMany: vi.fn() },
  pointEntry: { createMany: vi.fn() },
  agentAuditEvent: { create: vi.fn(), findMany: vi.fn() },
  agentEvent: { create: vi.fn() },
  webhookSubscription: { findMany: vi.fn() },
  webhookDelivery: { createMany: vi.fn() },
  issueClaim: { updateMany: vi.fn() },
  projectWorkflow: { findUnique: vi.fn() },
  project: { findFirst: vi.fn() },
  agentMistake: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));

const redesign = vi.hoisted(() => ({ assertRedesignOpen: vi.fn() }));
vi.mock("@/lib/redesigns", () => ({ assertRedesignOpen: redesign.assertRedesignOpen }));

const notify = vi.hoisted(() => ({ notifyMergeFailed: vi.fn() }));
vi.mock("@/lib/agent-notifications", () => ({ notifyMergeFailed: notify.notifyMergeFailed }));

import { IssueApiError } from "@/lib/agent-api/errors";
import { acceptFix as acceptFixRaw, executeAdminMerge } from "./merge";
import { resetWorkflowCache } from "@/lib/workflow";
import type { GitHubClient } from "@/lib/github/merge-pr";

function defaultMockGhClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: true, headSha: "linked-sha" })),
    checksGreen: vi.fn(async () => true),
    unresolvedCodeRabbitThreads: vi.fn(async () => 0),
    mergePullRequest: vi.fn(async () => ({ merged: true, sha: "git-merge-commit-sha" })),
    ...overrides,
  };
}

const PR = "https://github.com/Zedu-Endor/issue-tracker/pull/42";

/** A written merge review (#review-entries): every call to /merge carries one. */
const REVIEW = { verdict: "accept", summary: "Accept: small and tested.", description: "Two independent testers verified it on the linked commit." };

/** `acceptFix` with a written accept unless the test sends its own body. */
function acceptFix(
  agent: Parameters<typeof acceptFixRaw>[0],
  bugId: string,
  deps: Parameters<typeof acceptFixRaw>[2] = {},
  body: Record<string, unknown> = {},
) {
  return acceptFixRaw(agent, bugId, deps, { ...REVIEW, ...body });
}

/** The activity line a merge status logs (#review-entries: no comment), with its "What to do". */
function outcomeLine(): string {
  const call = db.bugActivity.create.mock.calls.find(
    (args: unknown[]) => (args[0] as { data: { metadata?: { field?: string } } }).data.metadata?.field === "merge",
  );
  if (!call) return "";
  const { summary, metadata } = call[0].data as { summary: string; metadata: { note?: string } };
  return `${summary} ${metadata.note ?? ""}`.trim();
}

function bugRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bug1",
    tenantId: "tenant_zedu",
    pullRequestUrl: PR,
    pullRequestHeadSha: "linked-sha",
    severity: "medium",
    status: "open",
    assigneeId: "ada",
    beneficiaryUserId: "ada",
    createdByAgentId: null,
    createdByAgent: null,
    project: { repoUrl: "https://github.com/Zedu-Endor/issue-tracker", githubInstallationId: "app-1" },
    claims: [{
      status: "active",
      releasedAt: null,
      agentId: "solver-agent",
      beneficiaryUserId: "ada",
      agent: { ownerUserId: "ada" },
    }],
    ...overrides,
  };
}

function merger(id: string, ownerId: string, level: AgentLevel = "manager") {
  return { agentId: id, name: id, ownerId, tenantId: "tenant_zedu", level, burst: false, keyId: `key-${id}` };
}

/** The two independent confirmation entries that confirm an issue (#issue-confirmations). */
function confirmWith(ownerA: string, ownerB: string) {
  const entry = (owner: string) => ({
    id: `c-${owner}`, bugId: "bug1", verdict: "confirm" as const, duplicateOfId: null, updatedAt: new Date("2026-10-20T10:00:00Z"),
    agentId: `a-${owner}`, onBehalfOfUserId: owner, agent: { ownerUserId: owner },
  });
  state.confirmations = [entry(ownerA), entry(ownerB)];
}

function verdict(
  agentId: string,
  ownerId: string,
  onBehalfOfUserId = ownerId,
  pullRequestUrl: string | null = PR,
  headSha: string | null = "linked-sha",
) {
  state.verdicts.push({
    id: `v-${agentId}`,
    bugId: "bug1",
    goodToMerge: true,
    pullRequestUrl,
    headSha,
    onBehalfOfUserId,
    createdAt: new Date(),
    agent: { id: agentId, ownerUserId: ownerId },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkflowCache();
  state.verdicts = [];
  state.confirmations = [];
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  db.bug.findFirst.mockResolvedValue(bugRow());
  db.bug.findUnique.mockResolvedValue(bugRow());
  db.bug.update.mockResolvedValue({});
  db.bugActivity.create.mockResolvedValue({});
  db.comment.create.mockResolvedValue({ id: "merge-comment-1" });
  db.mergeReview.findUnique.mockResolvedValue(null);
  db.mergeReview.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "review-1", createdAt: new Date(), updatedAt: new Date(), headSha: null, ...data,
  }));
  db.mergeReview.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
    id: where.id, createdAt: new Date(), updatedAt: new Date(), headSha: null, ...data,
  }));
  db.pointEntry.createMany.mockResolvedValue({ count: 1 });
  db.agentEvent.create.mockResolvedValue({ id: "e1" });
  db.webhookSubscription.findMany.mockResolvedValue([]);
  db.agentAuditEvent.findMany.mockResolvedValue([]);
  redesign.assertRedesignOpen.mockResolvedValue(undefined);
  db.testVerdict.findMany.mockImplementation(async ({ where }: { where: { pullRequestUrl?: string } }) =>
    state.verdicts.filter(
      (v) => v.bugId === "bug1" && v.goodToMerge && (where.pullRequestUrl === undefined || v.pullRequestUrl === where.pullRequestUrl),
    ),
  );
  db.bug.findMany.mockImplementation(async () => [{ ...bugRow(), projectId: "p1", reporterId: "ada" }]);
  db.issueConfirmation.findMany.mockImplementation(async () => state.confirmations);
  db.projectWorkflow.findUnique.mockResolvedValue(null);
});

describe("acceptFix: who may merge (#434)", () => {
  it("rejects a working agent before touching the issue: accepting needs a manager", async () => {
    expect(await acceptFix(merger("c1", "cara", "working"), "bug1")).toMatchObject({
      status: 403,
      error: "insufficient_level",
    });
    expect(await acceptFix(merger("r1", "rob", "working"), "bug1")).toMatchObject({
      status: 403,
      error: "insufficient_level",
    });
    expect(db.bug.findFirst).not.toHaveBeenCalled();
  });

  it("is 404 for an issue outside the agent's tenant", async () => {
    db.bug.findFirst.mockResolvedValue(null);
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 404 });
  });
});

describe("acceptFix: the merger must be independent too (#493)", () => {
  it("refuses the assigned solver's merger even if a different agent holds the claim", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow({ assigneeId: "mo" }));
    expect(await acceptFix(merger("m1", "mo"), "bug1")).toMatchObject({ status: 403, error: "not_independent" });
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });
  it("refuses a merger whose owner is the claim's beneficiary, even with every other gate met", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(
      bugRow({ claims: [{ status: "active", releasedAt: null, agentId: "w1", beneficiaryUserId: "ada", agent: { ownerUserId: "ada" } }] }),
    );

    expect(await acceptFix(merger("m1", "ada", "manager"), "bug1")).toMatchObject({
      status: 403,
      error: "not_independent",
    });
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
    expect(db.agentAuditEvent.create).not.toHaveBeenCalled();
  });

  it("refuses a merger whose owner is the ticket's reporter", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ reporterId: "ada", beneficiaryUserId: "zoe" }));
    expect(await acceptFix(merger("m1", "ada", "manager"), "bug1")).toMatchObject({
      status: 403,
      error: "not_independent",
    });
  });

  it("refuses a merger whose owner filed the ticket through its agent", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ createdByAgent: { ownerUserId: "ada" }, beneficiaryUserId: "zoe" }));
    expect(await acceptFix(merger("m1", "ada", "manager"), "bug1")).toMatchObject({
      status: 403,
      error: "not_independent",
    });
  });

  it("refuses a merger that owns the agent holding the active claim", async () => {
    db.bug.findFirst.mockResolvedValue(
      bugRow({ claims: [{ status: "active", releasedAt: null, agentId: "w1", beneficiaryUserId: "zoe", agent: { ownerUserId: "ada" } }] }),
    );
    expect(await acceptFix(merger("m1", "ada", "manager"), "bug1")).toMatchObject({
      status: 403,
      error: "not_independent",
    });
  });

  it("lets an independent merger accept", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1", { client: defaultMockGhClient() })).toMatchObject({ status: 200, accepted: true });
  });

  it("records the merge in the activity, not in a comment (#458, #review-entries)", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    expect(await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client: defaultMockGhClient() })).toMatchObject({ status: 200, accepted: true });
    expect(db.comment.create).not.toHaveBeenCalled();
    // The admin merge is an action: it gives no review.
    expect(db.mergeReview.create).not.toHaveBeenCalled();
    expect(db.bugActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "status_changed",
          metadata: expect.objectContaining({ to: "resolved", merged: true, mergeCommitSha: "git-merge-commit-sha", pullRequestUrl: PR }),
        }),
      }),
    );
    expect(db.bugActivity.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "commented" }) }),
    );
  });

  it("requires the project's third verdict when configured (#595)", async () => {
    db.projectWorkflow.findUnique.mockResolvedValue({ verdictsNeeded: 3 });
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1", { client: defaultMockGhClient() })).toMatchObject({
      status: 409,
      missing: "verdicts",
    });
    verdict("r3", "kim");
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1", { client: defaultMockGhClient() })).toMatchObject({ status: 200, accepted: true });
  });
});

describe("acceptFix: the gate (#434)", () => {
  it("names the missing condition: already accepted", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ status: "resolved" }));
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({
      status: 409,
      missing: "already_accepted",
    });
  });

  it("names the missing condition: no active claim", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ claims: [] }));
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({
      status: 409,
      missing: "claim",
    });
    expect(db.testVerdict.findMany).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("names the missing condition: no linked pull request", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ pullRequestUrl: null }));
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({
      status: 409,
      missing: "pull_request",
    });
    expect(db.testVerdict.findMany).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("refuses acceptance when the linked pull request was closed without being merged (#642)", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    const client = {
      getPullRequest: vi.fn(async () => ({ state: "closed", merged: false, mergeable: false, headSha: "sha1" })),
      checksGreen: vi.fn(async () => true),
      unresolvedCodeRabbitThreads: vi.fn(async () => 0),
      mergePullRequest: vi.fn(),
    };
    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", { client });
    expect(result).toMatchObject({
      status: 409,
      error: "not_ready",
      missing: "pull_request",
      message: "That pull request is closed without being merged.",
    });
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("refuses acceptance when the pull request is not in the project's repository (#642)", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(
      bugRow({
        pullRequestUrl: "https://github.com/someone-else/repo/pull/1",
        project: { repoUrl: "https://github.com/zedu/web", githubInstallationId: "123" },
      }),
    );
    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1");
    expect(result).toMatchObject({
      status: 409,
      error: "not_ready",
      missing: "pull_request",
      message: "That pull request is not in this project's repository.",
    });
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("names the missing condition: a redesign is waiting for a person", async () => {
    redesign.assertRedesignOpen.mockRejectedValue(new IssueApiError(409, "This redesign is waiting for a person."));
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 409, missing: "redesign" });
  });

  it("names the missing condition: not confirmed", async () => {
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 409, missing: "confirmation" });
    expect(db.bug.update).not.toHaveBeenCalled();
  });

  it("names the missing condition: fewer than two countable verdicts", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 409, missing: "verdicts" });
  });

  it("counts two verdicts from the same owner once", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "rob");
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 409, missing: "verdicts" });
  });

  it("drops a verdict from the claim holder's side", async () => {
    confirmWith("rob", "sam");
    db.bug.findFirst.mockResolvedValue(
      bugRow({ claims: [{ status: "active", releasedAt: null, agentId: "w1", beneficiaryUserId: "ada", agent: { ownerUserId: "rob" } }] }),
    );
    verdict("r1", "rob");
    verdict("r2", "rob");
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 409, missing: "verdicts" });
  });
});

describe("acceptFix: dispatcher completion reward", () => {
  it("pays the dispatcher of the completed claim, not an earlier abandoned claim", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow({ claims: [
      { status: "released", releasedAt: new Date(), dispatcherUserId: "old-dispatcher" },
      { status: "active", releasedAt: null, agentId: "solver-agent", beneficiaryUserId: "ada", dispatcherUserId: "dispatcher-owner", agent: { ownerUserId: "ada" } },
    ] }));

    expect(await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client: defaultMockGhClient() })).toMatchObject({ status: 200 });
    const rewards = db.pointEntry.createMany.mock.calls.flatMap((call) => call[0].data).filter((entry) => entry.role === "dispatcher");
    expect(rewards).toEqual([{
      tenantId: "tenant_zedu", bugId: "bug1", userId: "dispatcher-owner",
      role: "dispatcher", points: 60, sourceKey: "dispatcher:bug1",
    }]);
  });

  it("does not pay a dispatcher before independent verdicts accept the fix", async () => {
    confirmWith("rob", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow({ claims: [
      { status: "active", releasedAt: null, agentId: "solver-agent", beneficiaryUserId: "ada", dispatcherUserId: "dispatcher-owner", agent: { ownerUserId: "ada" } },
    ] }));
    expect(await acceptFix(merger("m1", "mo"), "bug1")).toMatchObject({ status: 409, missing: "verdicts" });
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("does not let the rewarded dispatcher accept its own assigned fix", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow({ claims: [
      { status: "active", releasedAt: null, agentId: "solver-agent", beneficiaryUserId: "ada", dispatcherUserId: "mo", agent: { ownerUserId: "ada" } },
    ] }));
    expect(await acceptFix(merger("m1", "mo"), "bug1")).toMatchObject({ status: 403, error: "not_independent" });
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });
});

describe("acceptFix: a successful accept (#434)", () => {
  it("resolves the issue and pays the assignee as solver, once", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client: defaultMockGhClient() });
    expect(result).toMatchObject({ status: 200, accepted: true, solverUserId: "ada" });
    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { status: "resolved" } });
    expect(db.bugActivity.create).toHaveBeenCalledWith({
      data: {
        bugId: "bug1",
        actorId: "mo",
        type: "status_changed",
        summary: "changed status from Open to Live",
        metadata: expect.objectContaining({ field: "status", from: "open", to: "resolved", mergeCommitSha: "git-merge-commit-sha" }),
      },
    });
    expect(db.issueClaim.updateMany).toHaveBeenCalledWith({
      where: { bugId: "bug1", status: "active", releasedAt: null },
      data: { status: "released", releasedAt: expect.any(Date), releaseReason: "resolved" },
    });

    const awards = db.pointEntry.createMany.mock.calls.map((call) => call[0].data[0]);
    expect(awards).toContainEqual({
      tenantId: "tenant_zedu",
      userId: "ada",
      bugId: "bug1",
      role: "solver",
      points: 750,
      sourceKey: "solver:bug1:ada",
    });
    expect(awards.filter((a) => a.role === "solver")).toHaveLength(1);
    expect(db.agentAuditEvent.create.mock.calls[0][0].data).toMatchObject({
      action: "issue.accepted",
      target: "bug:bug1",
      payload: {
        solverUserId: "ada",
        pullRequestUrl: PR,
        headSha: "linked-sha",
      },
    });
    expect(db.agentEvent.create.mock.calls[0][0].data).toMatchObject({ type: "issue.accepted", bugId: "bug1" });
  });

  it("pins the accepted fix to the head commit the last counted reviewer tested (#489)", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob", "rob", PR, "older-sha");
    verdict("r2", "sam", "sam", PR, "reviewed-sha");

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1", { client: defaultMockGhClient({ getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: true, headSha: "reviewed-sha" })) }) })).toMatchObject({ status: 200, accepted: true });
    expect(db.agentAuditEvent.create.mock.calls[0][0].data).toMatchObject({
      payload: { pullRequestUrl: PR, headSha: "reviewed-sha" },
    });
  });

  it("falls back to the linked head SHA when the verdicts name none (#489)", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob", "rob", PR, null);
    verdict("r2", "sam", "sam", PR, null);

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1", { client: defaultMockGhClient() })).toMatchObject({ status: 200, accepted: true });
    expect(db.agentAuditEvent.create.mock.calls[0][0].data).toMatchObject({
      payload: { pullRequestUrl: PR, headSha: "linked-sha" },
    });
  });

  it("releases the active solver claim as resolved in the accept transaction", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow({
      claims: [{ status: "active", releasedAt: null, agentId: "solver-agent", beneficiaryUserId: "ada", agent: { ownerUserId: "ada" } }],
    }));

    expect(await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client: defaultMockGhClient() })).toMatchObject({ status: 200, accepted: true });
    expect(db.issueClaim.updateMany).toHaveBeenCalledWith({
      where: { bugId: "bug1", status: "active", releasedAt: null },
      data: { status: "released", releasedAt: expect.any(Date), releaseReason: "resolved" },
    });
  });

  it("pays every good-to-merge reviewer, each less than the one before", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob", "rob");
    verdict("r2", "sam", "sam");
    verdict("r3", "tia", "tia");

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client: defaultMockGhClient() });
    expect(result).toMatchObject({ status: 200, rewardedReviewerUserIds: ["rob", "sam", "tia"] });
    const awards = db.pointEntry.createMany.mock.calls.map((call) => call[0].data[0]);
    const reviewerAwards = awards.filter((a) => a.role === "reviewer");
    expect(reviewerAwards).toHaveLength(3);
    expect(reviewerAwards[0]).toMatchObject({ userId: "rob", points: reviewerPointsAt(0, REVIEWER_POINTS), sourceKey: "reviewer:bug1:rob" });
    expect(reviewerAwards[1]).toMatchObject({ userId: "sam", points: reviewerPointsAt(1, REVIEWER_POINTS), sourceKey: "reviewer:bug1:sam" });
    expect(reviewerAwards[2]).toMatchObject({ userId: "tia", points: reviewerPointsAt(2, REVIEWER_POINTS), sourceKey: "reviewer:bug1:tia" });
    expect(reviewerAwards[2].points).toBeLessThan(reviewerAwards[1].points);
    expect(reviewerAwards[1].points).toBeLessThan(reviewerAwards[0].points);
  });

  it("merger accepts fix and marks ready to merge without resolving or awarding points", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", { client: defaultMockGhClient() });
    expect(result).toMatchObject({ status: 200, accepted: true, readyToMerge: true });
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
    expect(db.bugActivity.create).toHaveBeenCalledWith({
      data: {
        bugId: "bug1",
        actorId: "mo",
        type: "status_changed",
        summary: "Fix accepted by merger agent and marked ready to merge",
        metadata: { field: "status", readyToMerge: true, headSha: "linked-sha", mergeReviewId: "review-1" },
      },
    });
  });

  it("does not count or pay a verdict credited to the active claim beneficiary (#495)", async () => {
    confirmWith("rob", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow({ claims: [
      { status: "active", releasedAt: null, agentId: "worker-agent", beneficiaryUserId: "claimant", agent: { ownerUserId: "worker" } },
    ] }));
    verdict("r1", "rob", "claimant");
    verdict("r2", "sam", "sam");

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1");
    expect(result).toMatchObject({ status: 409, error: "not_ready", missing: "verdicts" });
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("pays the active claim's beneficiary rather than the assignee", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(
      bugRow({ assigneeId: "ada", claims: [{ status: "active", releasedAt: null, agentId: "w1", beneficiaryUserId: "zoe", agent: { ownerUserId: "zoe" } }] }),
    );

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client: defaultMockGhClient() });
    expect(result).toMatchObject({ solverUserId: "zoe" });
    const awards = db.pointEntry.createMany.mock.calls.map((call) => call[0].data[0]);
    expect(awards).toContainEqual(expect.objectContaining({ role: "solver", userId: "zoe", sourceKey: "solver:bug1:zoe" }));
  });

  it("accepts with no solver when nobody is assigned but an active claim has no beneficiary", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow({
      assigneeId: null,
      claims: [{
        status: "active",
        releasedAt: null,
        agentId: "solver-agent",
        beneficiaryUserId: null,
        agent: { ownerUserId: "ada" },
      }],
    }));

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client: defaultMockGhClient() });
    expect(result).toMatchObject({ status: 200, solverUserId: null });
    const awards = db.pointEntry.createMany.mock.calls.map((call) => call[0].data[0]);
    expect(awards.some((a) => a.role === "solver")).toBe(false);
  });

  it("records a status_changed bug activity matching human resolution when in_progress (#722)", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow({ status: "in_progress" }));

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client: defaultMockGhClient() });
    expect(result).toMatchObject({ status: 200, accepted: true });
    expect(db.bugActivity.create).toHaveBeenCalledWith({
      data: {
        bugId: "bug1",
        actorId: "mo",
        type: "status_changed",
        summary: "changed status from In progress to Live",
        metadata: expect.objectContaining({ field: "status", from: "in_progress", to: "resolved", merged: true }),
      },
    });
  });

  it("rejecting a fix records a merge review with the feedback, sends it back to In progress and records the mistake", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow());
    db.project.findFirst.mockResolvedValue({ id: "proj-1" });
    db.agentMistake.findFirst.mockResolvedValue(null);
    db.agentMistake.create.mockResolvedValue({ id: "m-1", title: "Missing unit tests", category: "correctness", recurrenceCount: 1 });

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", {}, {
      verdict: "reject",
      summary: "Reject: tests are missing.",
      description: "Tests missing for edge case.",
      mistake: {
        title: "Missing unit tests",
        antiPattern: "PR was submitted without edge case tests for boundary conditions.",
        remediation: "Always add tests covering empty and single-element collections.",
      },
    });

    expect(result).toMatchObject({
      status: 200,
      accepted: false,
      replaced: false,
      review: { id: "review-1", verdict: "reject", summary: "Reject: tests are missing.", description: "Tests missing for edge case.", pullRequestUrl: PR, headSha: "linked-sha" },
    });
    expect(db.mergeReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bugId: "bug1", agentId: "m1", onBehalfOfUserId: "mo", verdict: "reject", pullRequestUrl: PR }),
      }),
    );
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "bug1" },
      data: { status: "in_progress" },
    });
    expect(db.agentMistake.create).toHaveBeenCalled();
    // #review-entries: the review is the record; no comment narrates it.
    expect(db.comment.create).not.toHaveBeenCalled();
    expect(db.bugActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "status_changed", metadata: expect.objectContaining({ to: "in_progress", rejected: true, mergeReviewId: "review-1" }) }),
      }),
    );
    // #1429: the audit log keeps every merge decision.
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentId: "m1",
        action: "issue.merge_rejected",
        target: "bug:bug1",
        bugId: "bug1",
        payload: expect.objectContaining({ status: "in_progress", rejected: true, mergeReviewId: "review-1", notes: "Tests missing for edge case." }),
      }),
    });
  });

  it("reviewing again replaces the agent's review", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow());
    db.mergeReview.findUnique.mockResolvedValue({ id: "review-0" });

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", {}, {
      verdict: "reject",
      summary: "Reject again.",
      description: "The redirect still drops the session cookie.",
    });

    expect(result).toMatchObject({ status: 200, accepted: false, replaced: true, review: { id: "review-0", verdict: "reject" } });
    expect(db.mergeReview.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { bugId_agentId: { bugId: "bug1", agentId: "m1" } } }));
    expect(db.mergeReview.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "review-0" } }));
    expect(db.mergeReview.create).not.toHaveBeenCalled();
  });

  it("refuses a bare review (400) before touching the issue", async () => {
    const bare = await acceptFixRaw(merger("m1", "mo", "manager"), "bug1", {}, { verdict: "reject" });
    expect(bare).toMatchObject({ status: 400, error: "invalid_request", field: "summary" });
    const noDescription = await acceptFixRaw(merger("m1", "mo", "manager"), "bug1", {}, { verdict: "reject", summary: "No." });
    expect(noDescription).toMatchObject({ status: 400, field: "description" });
    const noVerdict = await acceptFixRaw(merger("m1", "mo", "manager"), "bug1", {}, { summary: "No.", description: "Why." });
    expect(noVerdict).toMatchObject({ status: 400, field: "verdict" });
    const tooLong = await acceptFixRaw(merger("m1", "mo", "manager"), "bug1", {}, { verdict: "accept", summary: "One. Two. Three.", description: "x" });
    expect(tooLong).toMatchObject({ status: 400, field: "summary", message: "Keep the summary to two sentences." });
    expect(db.bug.findFirst).not.toHaveBeenCalled();
    expect(db.mergeReview.create).not.toHaveBeenCalled();
  });

  it("a reject needs the reviewer to be independent of the fix, and a linked pull request", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow());
    const own = await acceptFix(merger("m1", "ada", "manager"), "bug1", {}, { verdict: "reject" });
    expect(own).toMatchObject({ status: 403, error: "not_independent" });
    db.bug.findFirst.mockResolvedValue(bugRow({ pullRequestUrl: null }));
    const noPr = await acceptFix(merger("m1", "mo", "manager"), "bug1", {}, { verdict: "reject" });
    expect(noPr).toMatchObject({ status: 409, missing: "pull_request" });
    expect(db.mergeReview.create).not.toHaveBeenCalled();
  });

  it("an accept records the manager's merge review and posts no comment", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", { client: defaultMockGhClient() });

    expect(result).toMatchObject({ status: 200, accepted: true, readyToMerge: true, review: { verdict: "accept", summary: REVIEW.summary, headSha: "linked-sha" } });
    expect(db.mergeReview.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ verdict: "accept", description: REVIEW.description, pullRequestUrl: PR, headSha: "linked-sha" }) }),
    );
    expect(db.comment.create).not.toHaveBeenCalled();
  });

  it("admin merger without a GitHub App records merge_blocked and resolves nothing", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client: null });

    expect(result).toMatchObject({ status: 409, error: "not_ready", missing: "github_app" });
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(outcomeLine()).toMatch(/Merge blocked/);
    expect(db.bug.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "resolved" }) }),
    );
    expect(outcomeLine()).toMatch(/^Merge blocked: The GitHub App is not set up/);
    expect(db.comment.create).not.toHaveBeenCalled();
    expect(db.issueClaim.updateMany).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("admin merger with no GitHub App configured on the server refuses instead of resolving", async () => {
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());

    let result;
    try {
      result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1");
    } finally {
      vi.unstubAllEnvs();
    }

    expect(result).toMatchObject({ status: 409, missing: "github_app" });
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("admin merger records merge_blocked while CodeRabbit threads are open, and does not merge", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());
    const client = defaultMockGhClient({ unresolvedCodeRabbitThreads: vi.fn(async () => 2) });

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client });

    expect(result).toMatchObject({ status: 409, missing: "review_threads", message: expect.stringContaining("2 unresolved review threads") });
    expect(client.mergePullRequest).not.toHaveBeenCalled();
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(outcomeLine()).toMatch(/Merge blocked/);
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("admin merger waits when CodeRabbit's threads can't be read", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());
    const client = defaultMockGhClient({ unresolvedCodeRabbitThreads: vi.fn(async () => { throw new Error("down"); }) });

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client });

    expect(result).toMatchObject({ status: 409, missing: "review_threads" });
    expect(client.mergePullRequest).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("admin merger records merge_failed when GitHub refuses the merge", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());
    const client = defaultMockGhClient({ mergePullRequest: vi.fn(async () => ({ merged: false, forbidden: true })) });

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client });

    expect(result).toMatchObject({ status: 409, missing: "github_merge_failed" });
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(outcomeLine()).toMatch(/Merge failed/);
    expect(outcomeLine()).toMatch(/^Merge failed: The app is not allowed/);
    expect(db.comment.create).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("admin merger takes the merge commit from GitHub, never from the request", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());

    // The admin-merge route reads no body, so nothing the caller sends can reach it.
    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client: defaultMockGhClient() });

    expect(result).toMatchObject({ status: 200, merged: true, mergeCommitSha: "git-merge-commit-sha" });
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "issue.accepted", payload: expect.objectContaining({ mergeCommitSha: "git-merge-commit-sha", merged: true }) }),
    });
  });

  it("admin merger refuses to merge when GitHub Actions CI/CD checks fail", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());
    const client = {
      getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: true, headSha: "linked-sha" })),
      checksGreen: vi.fn(async () => false),
      unresolvedCodeRabbitThreads: vi.fn(async () => 0),
      mergePullRequest: vi.fn(),
    };

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client });
    expect(result).toMatchObject({
      status: 409,
      error: "not_ready",
      missing: "deployment_verification",
      message: expect.stringContaining("GitHub Actions CI/CD checks"),
    });
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(outcomeLine()).toMatch(/Merge blocked/);
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
    // #1446: the failed deployment check is logged for the issue page.
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "github.merge_failed",
          payload: expect.objectContaining({ missing: "deployment_verification" }),
        }),
      }),
    );
  });

  it("admin merger logs a failed deployment when GitHub can't be reached (#1446)", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());
    const client = {
      getPullRequest: vi.fn(async () => {
        throw new Error("network");
      }),
      checksGreen: vi.fn(),
      unresolvedCodeRabbitThreads: vi.fn(async () => 0),
      mergePullRequest: vi.fn(),
    };

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client });
    expect(result).toMatchObject({
      status: 409,
      missing: "deployment_verification",
      message: "GitHub could not be reached to verify the pull request: network",
    });
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "github.merge_failed" }) }),
    );
  });

  it("admin merger refuses to merge and writes 0 points when the pull request is closed without being merged", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());
    const client = {
      getPullRequest: vi.fn(async () => ({ state: "closed", merged: false, mergeable: false, headSha: "linked-sha" })),
      checksGreen: vi.fn(async () => true),
      unresolvedCodeRabbitThreads: vi.fn(async () => 0),
      mergePullRequest: vi.fn(),
    };

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client });
    expect(result).toMatchObject({
      status: 409,
      error: "not_ready",
      missing: "pull_request",
      message: "That pull request is closed without being merged.",
    });
    expect(client.mergePullRequest).not.toHaveBeenCalled();
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("admin merger aborts transaction, emits github.merge_failed, and writes 0 points when GitHub merge fails", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());
    const client = {
      getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: true, headSha: "linked-sha" })),
      checksGreen: vi.fn(async () => true),
      unresolvedCodeRabbitThreads: vi.fn(async () => 0),
      mergePullRequest: vi.fn(async () => ({ merged: false, conflict: true })),
    };

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client });
    expect(result).toMatchObject({
      status: 409,
      error: "not_ready",
      missing: "github_merge_failed",
      message: "The pull request changed after its checks were verified.",
    });
    expect(client.mergePullRequest).toHaveBeenCalled();
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(outcomeLine()).toMatch(/Merge failed/);
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "github.merge_failed",
        }),
      }),
    );
  });

  it("admin merger executes mergePullRequest, persists mergeCommitSha, and resolves issue with points on success", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());
    const client = {
      getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: true, headSha: "linked-sha" })),
      checksGreen: vi.fn(async () => true),
      unresolvedCodeRabbitThreads: vi.fn(async () => 0),
      mergePullRequest: vi.fn(async () => ({ merged: true, sha: "git-merge-commit-sha-999" })),
    };

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client });
    expect(result).toMatchObject({
      status: 200,
      accepted: true,
      merged: true,
      mergeCommitSha: "git-merge-commit-sha-999",
      solverUserId: "ada",
    });
    expect(client.mergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "Zedu-Endor", repo: "issue-tracker" }),
      "linked-sha",
    );
    expect(db.bug.update).toHaveBeenCalledWith({
      where: { id: "bug1" },
      data: { status: "resolved" },
    });
    expect(db.pointEntry.createMany).toHaveBeenCalled();
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "issue.accepted",
          payload: expect.objectContaining({
            merged: true,
            mergeCommitSha: "git-merge-commit-sha-999",
          }),
        }),
      }),
    );
  });
});

describe("acceptFix counts verdicts on the linked pull request only (#526)", () => {
  it("ignores good-to-merge verdicts on an earlier pull request, or none", async () => {
    confirmWith("rob", "sam");
    verdict("r-rob", "rob", "rob", "https://github.com/Zedu-Endor/issue-tracker/pull/41");
    verdict("r-sam", "sam", "sam", null);
    const result = await acceptFix(merger("m1", "mo"), "bug1");
    expect(result).toMatchObject({ status: 409, missing: "verdicts" });
    expect(db.testVerdict.findMany.mock.calls[0][0].where).toMatchObject({ pullRequestUrl: PR });
  });
});

describe("acceptFix: a manager checks the fix won't break the code before accepting", () => {
  function readyToAccept() {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());
  }
  const acceptsNothing = () => {
    expect(db.bug.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ready_to_merge" }) }),
    );
    expect(db.agentAuditEvent.create).not.toHaveBeenCalled();
    // #review-entries: nothing is posted or recorded on the issue.
    expect(db.comment.create).not.toHaveBeenCalled();
    expect(db.bugActivity.create).not.toHaveBeenCalled();
    expect(db.mergeReview.create).not.toHaveBeenCalled();
  };
  /** The refusal the caller gets: every reason, then what the author has to do. */
  const refusal = (result: unknown, text: RegExp) => {
    const { message, todo } = result as { message: string; todo?: string };
    expect(`${message} What to do: ${todo ?? ""}`).toMatch(text);
  };

  it("does not accept while the pull request's checks are red, and says what the author must do", async () => {
    readyToAccept();
    const client = defaultMockGhClient({ checksGreen: vi.fn(async () => false) });

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", { client });

    expect(result).toMatchObject({ status: 409, error: "not_ready", missing: "deployment_verification" });
    acceptsNothing();
    refusal(result, /^GitHub Actions CI\/CD checks.* What to do: The author opens the pull request's Checks tab/);
  });

  it("does not give ready to merge to a pull request that conflicts: it comments and tells the author", async () => {
    readyToAccept();
    const client = defaultMockGhClient({
      getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: false, headSha: "linked-sha" })),
    });

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", { client });

    expect(result).toMatchObject({ status: 409, error: "not_ready", missing: "merge_conflict" });
    acceptsNothing();
    refusal(result, /merge conflicts.*don't resolve conflicts: the agent that delivered this fix and its owner have to\..*What to do: .*come and resolve it/);
    expect(notify.notifyMergeFailed).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: "ada", reason: expect.stringContaining("merge conflicts") }),
    );
  });

  it("does not accept while CodeRabbit has unresolved threads", async () => {
    readyToAccept();
    const client = defaultMockGhClient({ unresolvedCodeRabbitThreads: vi.fn(async () => 3) });

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1", { client })).toMatchObject({
      status: 409,
      missing: "review_threads",
      message: expect.stringContaining("3 unresolved review threads"),
    });
    acceptsNothing();
  });

  it("does not accept while a deployment is failing, and names it", async () => {
    readyToAccept();
    const client = defaultMockGhClient({
      failingChecks: vi.fn(async () => ['deployment to Production: failure, Build failed (https://vercel.example/d/1)']),
    });

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", { client });

    expect(result).toMatchObject({ status: 409, missing: "deployment_verification" });
    acceptsNothing();
    refusal(result, /Not green: deployment to Production: failure, Build failed \(https:\/\/vercel\.example\/d\/1\)/);
  });

  it("accepts when nothing is deployed for the commit and every check is green", async () => {
    readyToAccept();
    const client = defaultMockGhClient({ failingChecks: vi.fn(async () => []) });

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1", { client })).toMatchObject({ status: 200, accepted: true });
  });

  it("lists every reason when the pull request conflicts and the checks are red", async () => {
    readyToAccept();
    const client = defaultMockGhClient({
      getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: false, headSha: "linked-sha" })),
      checksGreen: vi.fn(async () => false),
    });

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", { client });

    expect(result).toMatchObject({ status: 409, missing: "merge_conflict", message: expect.stringContaining("for 2 reasons") });
    acceptsNothing();
    refusal(result, /for 2 reasons: \(1\) .*merge conflicts.*\(2\) GitHub Actions.*What to do: \(1\) .*\(2\) /);
  });

  it("does not accept when the head commit moved after the testers approved it", async () => {
    readyToAccept();
    const client = defaultMockGhClient({
      getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: true, headSha: "newer-sha" })),
    });

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", { client });

    expect(result).toMatchObject({ status: 409, missing: "pull_request", message: expect.stringContaining("head commit changed") });
    expect(client.checksGreen).not.toHaveBeenCalled();
    acceptsNothing();
  });

  it("does not accept when GitHub can't be reached", async () => {
    readyToAccept();
    const client = defaultMockGhClient({ getPullRequest: vi.fn(async () => { throw new Error("boom"); }) });

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", { client });

    expect(result).toMatchObject({ status: 409, missing: "deployment_verification" });
    acceptsNothing();
    refusal(result, /GitHub could not be reached.*Try accepting again/);
  });

  it("does not accept at all when the GitHub App isn't set up, since nothing can be checked", async () => {
    readyToAccept();

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", { client: null });

    expect(result).toMatchObject({ status: 409, missing: "github_app" });
    acceptsNothing();
  });

  it("accepts once GitHub says there are no conflicts and every check is green", async () => {
    readyToAccept();
    const client = defaultMockGhClient();

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1", { client })).toMatchObject({ status: 200, accepted: true });
    expect(client.checksGreen).toHaveBeenCalledWith(expect.anything(), "linked-sha");
  });
});

describe("executeAdminMerge: the merger checks again that the fix won't break the code", () => {
  const conflictingClient = (headSha = "linked-sha") =>
    defaultMockGhClient({
      getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: false, headSha })),
    });
  const readyToMerge = () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());
  };

  it("does not resolve or merge a conflict: it tells the fix's author to come and resolve it", async () => {
    readyToMerge();
    const client = conflictingClient();

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client });

    expect(result).toMatchObject({ status: 409, error: "not_ready", missing: "merge_conflict" });
    expect(client.mergePullRequest).not.toHaveBeenCalled();
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(outcomeLine()).toMatch(/Merge blocked/);
    expect(outcomeLine()).toMatch(
      /^Merge blocked: .*merge conflicts.*don't resolve conflicts: the agent that delivered this fix and its owner have to\. Nothing was merged.*What to do: .*come and resolve it.*git merge origin\/<base-branch>.*the testers check it and report again/,
    );
    expect(db.comment.create).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("names the agent that made the fix, and tells the person the claim was for", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(
      bugRow({
        claims: [{
          status: "active",
          releasedAt: null,
          agentId: "solver-agent",
          beneficiaryUserId: "ada",
          agent: { ownerUserId: "ada", name: "Ada's Claude" },
        }],
      }),
    );

    await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client: conflictingClient() });

    expect(outcomeLine()).toContain("Ada's Claude and its owner have to");
    expect(notify.notifyMergeFailed).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: "ada", reason: expect.stringContaining("merge conflicts") }),
    );
  });

  it("does not wave a moved head commit through after a conflict: the testers check the new commit", async () => {
    readyToMerge();
    const client = defaultMockGhClient({
      getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: true, headSha: "resolved-sha" })),
    });

    expect(await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client })).toMatchObject({
      status: 409,
      missing: "pull_request",
      message: expect.stringContaining("head commit changed"),
    });
    expect(client.mergePullRequest).not.toHaveBeenCalled();
  });

  it("lists every reason in one comment when the merge has more than one problem", async () => {
    readyToMerge();
    const client = defaultMockGhClient({
      getPullRequest: vi.fn(async () => ({ state: "open", merged: false, mergeable: false, headSha: "linked-sha" })),
      checksGreen: vi.fn(async () => false),
      unresolvedCodeRabbitThreads: vi.fn(async () => 1),
    });

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client });

    expect(result).toMatchObject({ status: 409, missing: "merge_conflict" });
    expect(client.mergePullRequest).not.toHaveBeenCalled();
    expect(outcomeLine()).toMatch(/for 3 reasons: \(1\) .*merge conflicts.*\(2\) GitHub Actions.*\(3\) CodeRabbit has 1 unresolved review thread.*What to do: \(1\) .*\(2\) .*\(3\) /);
  });

  it("does not merge while a deployment is failing, and names the failing deployment", async () => {
    readyToMerge();
    const client = defaultMockGhClient({
      failingChecks: vi.fn(async () => ['status "Vercel": failure, Deployment failed (https://vercel.example/d/9)']),
    });

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client });

    expect(result).toMatchObject({ status: 409, missing: "deployment_verification", message: expect.stringContaining('status "Vercel": failure') });
    expect(client.mergePullRequest).not.toHaveBeenCalled();
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(outcomeLine()).toMatch(/Merge blocked/);
  });

  it("tells the author what to do when the checks are red", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());
    const client = defaultMockGhClient({ checksGreen: vi.fn(async () => false) });

    const result = await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client });

    expect(result).toMatchObject({ status: 409, missing: "deployment_verification" });
    expect(client.mergePullRequest).not.toHaveBeenCalled();
    expect(outcomeLine()).toContain("What to do: The author opens the pull request's Checks tab");
    expect(result).toMatchObject({ todo: expect.stringContaining("The author opens the pull request's Checks tab") });
  });

  it("doesn't treat an already merged pull request as conflicting", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());
    const client = defaultMockGhClient({
      getPullRequest: vi.fn(async () => ({ state: "closed", merged: true, mergeable: false, headSha: "linked-sha" })),
    });

    expect(await executeAdminMerge(merger("m1", "mo", "merger"), "bug1", { client })).toMatchObject({ status: 200, accepted: true });
  });
});
