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
  pullRequestReport: { findFirst: vi.fn() },
  issueConfirmation: { findMany: vi.fn() },
  pointEntry: { createMany: vi.fn() },
  agentAuditEvent: { create: vi.fn(), findMany: vi.fn() },
  agentEvent: { create: vi.fn() },
  webhookSubscription: { findMany: vi.fn() },
  webhookDelivery: { createMany: vi.fn() },
  issueClaim: { updateMany: vi.fn() },
  delivery: { findMany: vi.fn() },
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
import { deliveredClaim } from "@/lib/agent-api/merge-verdicts";
import { acceptFix as acceptFixRaw, finalizeResolved, type FinalizeResolvedInput } from "./merge";
import { resetWorkflowCache } from "@/lib/workflow";

const PR = "https://github.com/Zedu-Endor/issue-tracker/pull/42";

/** A written merge review (#review-entries): every call to /merge carries one. */
const REVIEW = { verdict: "accept", summary: "Accept: small and tested.", description: "Two independent testers verified it on the linked commit." };

/** `acceptFix` with a written accept unless the test sends its own body. */
function acceptFix(
  agent: Parameters<typeof acceptFixRaw>[0],
  bugId: string,
  body: Record<string, unknown> = {},
) {
  return acceptFixRaw(agent, bugId, { ...REVIEW, ...body });
}

function bugRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bug1",
    title: "Session cookie dropped on redirect",
    tenantId: "tenant_zedu",
    pullRequestUrl: PR,
    pullRequestHeadSha: "linked-sha",
    status: "open", substatus: "open",
    assigneeId: "ada",
    beneficiaryUserId: "ada",
    createdByAgentId: null,
    createdByAgent: null,
    // The pull request link is in the project's repository (#pr-reports gate).
    project: { repoUrl: "https://github.com/Zedu-Endor/issue-tracker" },
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

/** The latest independent report on the pull request (#pr-reports): open, passing, at the bug's head. */
function reportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "report-1",
    bugId: "bug1",
    pullRequestUrl: PR,
    state: "open",
    mergedInto: null,
    inDefaultBranch: null,
    headSha: "linked-sha",
    mergeCommitSha: null,
    checks: "passing",
    mergeable: true,
    note: "Open, checks green, no conflict.",
    agentId: "reporter-agent",
    onBehalfOfUserId: "kim",
    createdAt: new Date("2026-10-30T10:00:00Z"),
    agent: { name: "reporter-agent" },
    onBehalfOf: { name: "Kim" },
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
  // Three confirms of weight 1 reach the default threshold of 3 (#confirmation-weights).
  state.confirmations = [entry(ownerA), entry(ownerB), entry(`${ownerB}-third`)];
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
  // No delivery filed on the claim holder's behalf unless a test adds one.
  db.delivery.findMany.mockResolvedValue([]);
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
  // The pull request is reported open, checks passing, mergeable, at the bug's head.
  db.pullRequestReport.findFirst.mockResolvedValue(reportRow());
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
  it("refuses a working agent in a manager-governed project and writes nothing: accepting needs a manager", async () => {
    expect(await acceptFix(merger("c1", "cara", "working"), "bug1")).toMatchObject({
      status: 403,
      error: "insufficient_level",
    });
    expect(await acceptFix(merger("r1", "rob", "working"), "bug1")).toMatchObject({
      status: 403,
      error: "insufficient_level",
    });
    // The issue may be read (threshold-only projects let working agents review), but nothing is written.
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.mergeReview.create).not.toHaveBeenCalled();
    expect(db.mergeReview.update).not.toHaveBeenCalled();
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.bugActivity.create).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
    expect(db.agentEvent.create).not.toHaveBeenCalled();
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
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 200, accepted: true });
  });

  it("requires the project's third verdict when configured (#595)", async () => {
    db.projectWorkflow.findUnique.mockResolvedValue({ verdictsNeeded: 3 });
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({
      status: 409,
      missing: "verdicts",
    });
    verdict("r3", "kim");
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 200, accepted: true });
  });
});

describe("acceptFix: the gate (#434)", () => {
  it("names the missing condition: already accepted", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ status: "resolved", substatus: "on_dev" }));
    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({
      status: 409,
      missing: "already_accepted",
    });
  });

  it("names the missing condition: no active claim", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow({ claims: [] }));
    db.delivery.findMany.mockResolvedValue([]);
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

  it("refuses acceptance when the linked pull request is reported closed without being merged (#642)", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.pullRequestReport.findFirst.mockResolvedValue(reportRow({ state: "closed", mergeable: null, checks: null }));
    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1");
    expect(result).toMatchObject({
      status: 409,
      error: "pr_broken",
      message: expect.stringContaining("closed without being merged"),
    });
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("refuses acceptance when the pull request is not in the project's repository (#642)", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob", "rob", "https://github.com/someone-else/repo/pull/1");
    verdict("r2", "sam", "sam", "https://github.com/someone-else/repo/pull/1");
    db.bug.findFirst.mockResolvedValue(
      bugRow({
        pullRequestUrl: "https://github.com/someone-else/repo/pull/1",
        project: { repoUrl: "https://github.com/zedu/web" },
      }),
    );
    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1");
    expect(result).toMatchObject({
      status: 409,
      error: "pr_broken",
      message: expect.stringContaining("not in the project's repository"),
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
  it("makes the issue ready to merge, records the report it read, and pays nothing yet", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1");
    expect(result).toMatchObject({ status: 200, accepted: true, readyToMerge: true, solverUserId: "ada", rewardedReviewerUserIds: ["rob", "sam"] });
    expect(db.pullRequestReport.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bugId: "bug1", pullRequestUrl: PR } }),
    );
    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { status: "merge", substatus: "ready_to_merge" } });
    expect(db.issueClaim.updateMany).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
    expect(db.agentAuditEvent.create.mock.calls[0][0].data).toMatchObject({
      action: "issue.accepted",
      target: "bug:bug1",
      payload: {
        solverUserId: "ada",
        pullRequestUrl: PR,
        headSha: "linked-sha",
        status: "merge", substatus: "ready_to_merge",
        pullRequestReportId: "report-1",
      },
    });
    expect(db.agentEvent.create.mock.calls[0][0].data).toMatchObject({ type: "issue.updated", bugId: "bug1" });
  });

  it("pins the accepted fix to the head commit the last counted reviewer tested (#489)", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob", "rob", PR, "older-sha");
    verdict("r2", "sam", "sam", PR, "reviewed-sha");
    db.bug.findFirst.mockResolvedValue(bugRow({ pullRequestHeadSha: "reviewed-sha" }));
    db.pullRequestReport.findFirst.mockResolvedValue(reportRow({ headSha: "reviewed-sha" }));

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 200, accepted: true });
    expect(db.agentAuditEvent.create.mock.calls[0][0].data).toMatchObject({
      payload: { pullRequestUrl: PR, headSha: "reviewed-sha" },
    });
  });

  it("falls back to the linked head SHA when the verdicts name none (#489)", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob", "rob", PR, null);
    verdict("r2", "sam", "sam", PR, null);

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 200, accepted: true });
    expect(db.agentAuditEvent.create.mock.calls[0][0].data).toMatchObject({
      payload: { pullRequestUrl: PR, headSha: "linked-sha" },
    });
  });

  it("names every good-to-merge reviewer it will reward, in order", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob", "rob");
    verdict("r2", "sam", "sam");
    verdict("r3", "tia", "tia");

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1");
    expect(result).toMatchObject({ status: 200, rewardedReviewerUserIds: ["rob", "sam", "tia"] });
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  });

  it("a manager accepts the fix and marks it ready to merge without resolving or awarding points", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1");
    expect(result).toMatchObject({ status: 200, accepted: true, readyToMerge: true });
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
    expect(db.bugActivity.create).toHaveBeenCalledWith({
      data: {
        bugId: "bug1",
        actorId: "mo",
        type: "status_changed",
        summary: "Fix accepted by a manager agent and marked ready to merge",
        metadata: { field: "status", readyToMerge: true, headSha: "linked-sha", mergeReviewId: "review-1", pullRequestReportId: "report-1" },
      },
    });
  });

  it("a merger agent's accept is the same as a manager's: ready to merge, nothing resolved or paid", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");

    const result = await acceptFix(merger("m1", "mo", "merger"), "bug1");

    expect(result).toMatchObject({ status: 200, accepted: true, readyToMerge: true });
    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { status: "merge", substatus: "ready_to_merge" } });
    expect(db.bug.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "resolved", substatus: "on_dev" }) }),
    );
    expect(db.issueClaim.updateMany).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
    expect(db.mergeReview.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ verdict: "accept", agentId: "m1" }) }),
    );
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

  it("names the active claim's beneficiary as the solver rather than the assignee", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(
      bugRow({ assigneeId: "ada", claims: [{ status: "active", releasedAt: null, agentId: "w1", beneficiaryUserId: "zoe", agent: { ownerUserId: "zoe" } }] }),
    );

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 200, solverUserId: "zoe" });
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

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 200, solverUserId: null });
  });

  it("rejecting a fix records a merge review with the feedback, sends it back to In progress and records the mistake", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow());
    db.project.findFirst.mockResolvedValue({ id: "proj-1" });
    db.agentMistake.findFirst.mockResolvedValue(null);
    db.agentMistake.create.mockResolvedValue({ id: "m-1", title: "Missing unit tests", category: "correctness", recurrenceCount: 1 });

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", {
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
      data: { status: "in_progress", substatus: "in_progress" },
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
        payload: expect.objectContaining({ status: "in_progress", substatus: "in_progress", rejected: true, mergeReviewId: "review-1", notes: "Tests missing for edge case." }),
      }),
    });
  });

  it("reviewing again replaces the agent's review", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow());
    db.mergeReview.findUnique.mockResolvedValue({ id: "review-0" });

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1", {
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
    const bare = await acceptFixRaw(merger("m1", "mo", "manager"), "bug1", { verdict: "reject" });
    expect(bare).toMatchObject({ status: 400, error: "invalid_request", field: "summary" });
    const noDescription = await acceptFixRaw(merger("m1", "mo", "manager"), "bug1", { verdict: "reject", summary: "No." });
    expect(noDescription).toMatchObject({ status: 400, field: "description" });
    const noVerdict = await acceptFixRaw(merger("m1", "mo", "manager"), "bug1", { summary: "No.", description: "Why." });
    expect(noVerdict).toMatchObject({ status: 400, field: "verdict" });
    const tooLong = await acceptFixRaw(merger("m1", "mo", "manager"), "bug1", { verdict: "accept", summary: "One. Two. Three.", description: "x" });
    expect(tooLong).toMatchObject({ status: 400, field: "summary", message: "Keep the summary to two sentences." });
    expect(db.bug.findFirst).not.toHaveBeenCalled();
    expect(db.mergeReview.create).not.toHaveBeenCalled();
  });

  it("a reject needs the reviewer to be independent of the fix, and a linked pull request", async () => {
    db.bug.findFirst.mockResolvedValue(bugRow());
    const own = await acceptFix(merger("m1", "ada", "manager"), "bug1", { verdict: "reject" });
    expect(own).toMatchObject({ status: 403, error: "not_independent" });
    db.bug.findFirst.mockResolvedValue(bugRow({ pullRequestUrl: null }));
    const noPr = await acceptFix(merger("m1", "mo", "manager"), "bug1", { verdict: "reject" });
    expect(noPr).toMatchObject({ status: 409, missing: "pull_request" });
    expect(db.mergeReview.create).not.toHaveBeenCalled();
  });

  it("an accept records the manager's merge review and posts no comment", async () => {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1");

    expect(result).toMatchObject({ status: 200, accepted: true, readyToMerge: true, review: { verdict: "accept", summary: REVIEW.summary, headSha: "linked-sha" } });
    expect(db.mergeReview.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ verdict: "accept", description: REVIEW.description, pullRequestUrl: PR, headSha: "linked-sha" }) }),
    );
    expect(db.comment.create).not.toHaveBeenCalled();
    expect(db.bugActivity.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "commented" }) }),
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

describe("acceptFix: the latest pull request report must say it can merge (#pr-reports)", () => {
  function readyToAccept() {
    confirmWith("rob", "sam");
    verdict("r1", "rob");
    verdict("r2", "sam");
    db.bug.findFirst.mockResolvedValue(bugRow());
  }
  const acceptsNothing = () => {
    expect(db.bug.update).not.toHaveBeenCalled();
    expect(db.agentAuditEvent.create).not.toHaveBeenCalled();
    // #review-entries: nothing is posted or recorded on the issue.
    expect(db.comment.create).not.toHaveBeenCalled();
    expect(db.bugActivity.create).not.toHaveBeenCalled();
    expect(db.mergeReview.create).not.toHaveBeenCalled();
    expect(db.pointEntry.createMany).not.toHaveBeenCalled();
  };

  it("refuses with needs_pr_report when nobody has reported the pull request", async () => {
    readyToAccept();
    db.pullRequestReport.findFirst.mockResolvedValue(null);

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1");

    expect(result).toMatchObject({ status: 409, error: "needs_pr_report", todo: expect.stringContaining("pull-request-status") });
    acceptsNothing();
    expect(notify.notifyMergeFailed).not.toHaveBeenCalled();
  });

  it("refuses with needs_pr_report while the reported head isn't the head Ziki has", async () => {
    readyToAccept();
    db.pullRequestReport.findFirst.mockResolvedValue(reportRow({ headSha: "stale-sha" }));

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 409, error: "needs_pr_report" });
    acceptsNothing();
  });

  it("refuses with needs_pr_report while the reported checks are still running", async () => {
    readyToAccept();
    db.pullRequestReport.findFirst.mockResolvedValue(reportRow({ checks: "pending" }));

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 409, error: "needs_pr_report" });
    acceptsNothing();
  });

  it("refuses with already_merged when the report says it is merged into the default branch, pointing at resolve", async () => {
    readyToAccept();
    db.pullRequestReport.findFirst.mockResolvedValue(
      reportRow({ state: "merged", mergedInto: "main", inDefaultBranch: true, mergeCommitSha: "merge-sha" }),
    );

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({
      status: 409,
      error: "already_merged",
      todo: expect.stringContaining("/resolve"),
    });
    acceptsNothing();
  });

  it("refuses with awaiting_release when it was merged into a branch the default branch doesn't contain yet", async () => {
    readyToAccept();
    db.pullRequestReport.findFirst.mockResolvedValue(
      reportRow({ state: "merged", mergedInto: "staging", inDefaultBranch: false, mergeCommitSha: "merge-sha" }),
    );

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({
      status: 409,
      error: "awaiting_release",
      message: expect.stringContaining('"staging"'),
    });
    acceptsNothing();
  });

  it("refuses with pr_broken when the report says the pull request doesn't exist, and tells the author", async () => {
    readyToAccept();
    db.pullRequestReport.findFirst.mockResolvedValue(reportRow({ state: "not_found", checks: null, mergeable: null, headSha: null }));

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 409, error: "pr_broken" });
    acceptsNothing();
    expect(notify.notifyMergeFailed).toHaveBeenCalledWith(expect.objectContaining({ recipientId: "ada", bugId: "bug1" }));
  });

  it("refuses with pr_not_ready while the reported checks fail, and tells the author", async () => {
    readyToAccept();
    db.pullRequestReport.findFirst.mockResolvedValue(reportRow({ checks: "failing" }));

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1");

    expect(result).toMatchObject({ status: 409, error: "pr_not_ready", message: expect.stringContaining("checks are failing") });
    acceptsNothing();
    expect(notify.notifyMergeFailed).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: "ada", reason: expect.stringContaining("checks are failing") }),
    );
  });

  it("does not give ready to merge to a pull request that conflicts: it names the agent that must resolve it and tells its owner", async () => {
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
    db.pullRequestReport.findFirst.mockResolvedValue(reportRow({ mergeable: false }));

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1");

    expect(result).toMatchObject({
      status: 409,
      error: "pr_not_ready",
      message: expect.stringContaining("merge conflicts"),
      todo: expect.stringMatching(/^Ada's Claude \(and its owner\) come and resolve it.*git merge origin\/<base-branch>/),
    });
    acceptsNothing();
    expect(notify.notifyMergeFailed).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: "ada", reason: expect.stringContaining("merge conflicts") }),
    );
  });

  it("does not accept when the reported head commit moved after the testers approved it", async () => {
    readyToAccept();
    // Ziki and the report agree on the new head; the testers approved linked-sha.
    db.bug.findFirst.mockResolvedValue(bugRow({ pullRequestHeadSha: "newer-sha" }));
    db.pullRequestReport.findFirst.mockResolvedValue(reportRow({ headSha: "newer-sha" }));

    const result = await acceptFix(merger("m1", "mo", "manager"), "bug1");

    expect(result).toMatchObject({ status: 409, error: "not_ready", missing: "pull_request", message: expect.stringContaining("head commit") });
    acceptsNothing();
  });

  it("ignores a report on another pull request address", async () => {
    readyToAccept();
    db.pullRequestReport.findFirst.mockResolvedValue(reportRow({ pullRequestUrl: "https://github.com/Zedu-Endor/issue-tracker/pull/41" }));

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 409, error: "needs_pr_report" });
    acceptsNothing();
  });

  it("accepts when the report says it has no checks at all", async () => {
    readyToAccept();
    db.pullRequestReport.findFirst.mockResolvedValue(reportRow({ checks: "none" }));

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 200, accepted: true });
  });

  it("accepts once the report says it is open, conflict-free and its checks pass", async () => {
    readyToAccept();

    expect(await acceptFix(merger("m1", "mo", "manager"), "bug1")).toMatchObject({ status: 200, accepted: true, readyToMerge: true });
    expect(notify.notifyMergeFailed).not.toHaveBeenCalled();
  });
});

describe("finalizeResolved: merged work goes Live and pays each side once (#434)", () => {
  function resolveInput(overrides: Partial<FinalizeResolvedInput> = {}, row = bugRow()): FinalizeResolvedInput {
    return {
      agent: merger("m1", "mo", "manager"),
      bug: { id: "bug1", tenantId: "tenant_zedu", projectId: "p1", status: row.status, substatus: row.substatus, pullRequestUrl: PR },
      claim: deliveredClaim(row as unknown as Parameters<typeof deliveredClaim>[0]) as unknown as FinalizeResolvedInput["claim"],
      solverUserId: "ada",
      rewardedReviewerUserIds: ["rob", "sam"],
      acceptedHeadSha: "linked-sha",
      mergeCommitSha: "git-merge-commit-sha",
      ...overrides,
    } as FinalizeResolvedInput;
  }
  const tx = db as unknown as Parameters<typeof finalizeResolved>[0];

  it("resolves the issue, releases the claim and pays the solver once", async () => {
    await finalizeResolved(tx, resolveInput());

    expect(db.bug.update).toHaveBeenCalledWith({ where: { id: "bug1" }, data: { status: "resolved", substatus: "on_dev" } });
    expect(db.bugActivity.create).toHaveBeenCalledWith({
      data: {
        bugId: "bug1",
        actorId: "mo",
        type: "status_changed",
        summary: "changed status from Open · Open to Live · On dev",
        metadata: expect.objectContaining({ field: "status", from: "open", to: "on_dev", merged: true, pullRequestUrl: PR, mergeCommitSha: "git-merge-commit-sha" }),
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
      // #710: the agent that held the claim earned it.
      agentId: "solver-agent",
    });
    expect(awards.filter((a) => a.role === "solver")).toHaveLength(1);
    expect(db.agentAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "issue.accepted",
        target: "bug:bug1",
        payload: expect.objectContaining({ solverUserId: "ada", pullRequestUrl: PR, headSha: "linked-sha", mergeCommitSha: "git-merge-commit-sha", merged: true }),
      }),
    });
    expect(db.agentEvent.create.mock.calls[0][0].data).toMatchObject({ type: "issue.accepted", bugId: "bug1" });
    expect(db.comment.create).not.toHaveBeenCalled();
  });

  it("names the status it came from when In progress (#722)", async () => {
    await finalizeResolved(tx, resolveInput({}, bugRow({ status: "in_progress", substatus: "in_progress" })));
    expect(db.bugActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        summary: "changed status from In progress to Live · On dev",
        metadata: expect.objectContaining({ from: "in_progress", to: "on_dev", merged: true }),
      }),
    });
  });

  it("pays every good-to-merge reviewer, each less than the one before", async () => {
    await finalizeResolved(tx, resolveInput({ rewardedReviewerUserIds: ["rob", "sam", "tia"] }));
    const awards = db.pointEntry.createMany.mock.calls.map((call) => call[0].data[0]);
    const reviewerAwards = awards.filter((a) => a.role === "reviewer");
    expect(reviewerAwards).toHaveLength(3);
    expect(reviewerAwards[0]).toMatchObject({ userId: "rob", points: reviewerPointsAt(0, REVIEWER_POINTS), sourceKey: "reviewer:bug1:rob" });
    expect(reviewerAwards[1]).toMatchObject({ userId: "sam", points: reviewerPointsAt(1, REVIEWER_POINTS), sourceKey: "reviewer:bug1:sam" });
    expect(reviewerAwards[2]).toMatchObject({ userId: "tia", points: reviewerPointsAt(2, REVIEWER_POINTS), sourceKey: "reviewer:bug1:tia" });
    expect(reviewerAwards[2].points).toBeLessThan(reviewerAwards[1].points);
    expect(reviewerAwards[1].points).toBeLessThan(reviewerAwards[0].points);
  });

  it("pays no solver when there is none", async () => {
    await finalizeResolved(tx, resolveInput({ solverUserId: null }));
    const awards = db.pointEntry.createMany.mock.calls.map((call) => call[0].data[0]);
    expect(awards.some((a) => a.role === "solver")).toBe(false);
  });

  it("pays the dispatcher of the completed claim, not an earlier abandoned claim", async () => {
    const row = bugRow({ claims: [
      { status: "released", releasedAt: new Date(), dispatcherUserId: "old-dispatcher" },
      { status: "active", releasedAt: null, agentId: "solver-agent", beneficiaryUserId: "ada", dispatcherUserId: "dispatcher-owner", agent: { ownerUserId: "ada" } },
    ] });

    await finalizeResolved(tx, resolveInput({}, row));

    const rewards = db.pointEntry.createMany.mock.calls.flatMap((call) => call[0].data).filter((entry) => entry.role === "dispatcher");
    expect(rewards).toEqual([{
      tenantId: "tenant_zedu", bugId: "bug1", userId: "dispatcher-owner",
      role: "dispatcher", points: 60, sourceKey: "dispatcher:bug1",
    }]);
  });
});
