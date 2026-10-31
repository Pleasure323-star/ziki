import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const tx = {
    pullRequestReport: { create: vi.fn() },
    bug: { updateMany: vi.fn() },
  };
  return {
    bug: { findFirst: vi.fn() },
    delivery: { findFirst: vi.fn() },
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    tx,
  };
});
const publish = vi.hoisted(() => vi.fn());
const audit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/events", () => ({ publish }));
vi.mock("@/lib/agents/audit", () => ({ audit }));
vi.mock("@/lib/agent-notifications", () => ({ notifyMergeFailed: vi.fn() }));

import type { AgentContext } from "@/lib/agents/require-agent";
import { reportPullRequestStatus } from "./pull-request-report";

const PR = "https://github.com/emerjent/ziki/pull/552";
const scope = { tenantId: "t1", projectId: "p1" };
const checker = (ownerId = "erin", level: AgentContext["level"] = "working"): AgentContext =>
  ({ agentId: `agent-${ownerId}`, name: `${ownerId}'s agent`, ownerId, tenantId: "t1", level, burst: false, keyId: "k" });

/** Delivered work on #552, filed by Ada, the claim held by Cara's agent. */
function bug(over: Record<string, unknown> = {}) {
  return {
    id: "bug1", tenantId: "t1", projectId: "p1",
    pullRequestUrl: PR, pullRequestHeadSha: "aaa1111",
    beneficiaryUserId: "ada", reporterId: "ada", assigneeId: null, createdByAgent: null,
    claims: [{ status: "active", releasedAt: null, beneficiaryUserId: "cara", dispatcherUserId: null, agent: { ownerUserId: "cara" } }],
    ...over,
  };
}

const openBody = (over: Record<string, unknown> = {}) => ({
  pullRequestUrl: PR,
  state: "open",
  headSha: "aaa1111",
  checks: "passing",
  mergeable: true,
  note: "Open, checks green, no conflict.",
  ...over,
});

/** The stored row, echoing what was created. */
function savedRow(data: Record<string, unknown>) {
  return {
    id: "rep1",
    ...data,
    createdAt: new Date("2026-10-31T10:00:00Z"),
    agent: { name: "erin's agent" },
    onBehalfOf: { name: "Erin" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.bug.findFirst.mockResolvedValue(bug());
  db.delivery.findFirst.mockResolvedValue(null);
  db.tx.pullRequestReport.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => savedRow(data));
  db.tx.bug.updateMany.mockResolvedValue({ count: 1 });
});

describe("reportPullRequestStatus (#pr-reports)", () => {
  it("stores the report, audits it and publishes issue.pull_request_reported (201)", async () => {
    const result = await reportPullRequestStatus(checker(), scope, "bug1", openBody());
    expect(result).toMatchObject({
      status: 201,
      body: {
        report: {
          id: "rep1", pullRequestUrl: PR, state: "open", headSha: "aaa1111", checks: "passing", mergeable: true,
          note: "Open, checks green, no conflict.",
          reportedBy: { agentId: "agent-erin", agentName: "erin's agent", userId: "erin", name: "Erin" },
        },
      },
    });
    expect(db.bug.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "bug1", ...scope, isDeleted: false } }));
    expect(db.tx.pullRequestReport.create).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        bugId: "bug1", pullRequestUrl: PR, state: "open", mergedInto: null, inDefaultBranch: null, headSha: "aaa1111",
        mergeCommitSha: null, checks: "passing", mergeable: true, note: "Open, checks green, no conflict.",
        agentId: "agent-erin", onBehalfOfUserId: "erin",
      },
    }));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-erin" }),
      "issue.pull_request_reported",
      "bug:bug1",
      expect.objectContaining({ issueId: "bug1", reportId: "rep1", pullRequestUrl: PR, state: "open" }),
      expect.objectContaining({ bugId: "bug1", db: db.tx }),
    );
    expect(publish).toHaveBeenCalledWith(db.tx, expect.objectContaining({
      tenantId: "t1",
      type: "issue.pull_request_reported",
      actorAgentId: "agent-erin",
      bugId: "bug1",
      payload: expect.objectContaining({ reportId: "rep1", state: "open" }),
    }));
    // The head is the one Ziki has: nothing moves.
    expect(db.tx.bug.updateMany).not.toHaveBeenCalled();
  });

  it("records the new head on the issue when an open pull request is reported at another commit", async () => {
    const result = await reportPullRequestStatus(checker(), scope, "bug1", openBody({ headSha: "bbb2222" }));
    expect(result.status).toBe(201);
    expect(db.tx.bug.updateMany).toHaveBeenCalledWith({ where: { id: "bug1", pullRequestUrl: PR }, data: { pullRequestHeadSha: "bbb2222" } });
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      "issue.pull_request_reported",
      "bug:bug1",
      expect.objectContaining({ headMoved: { from: "aaa1111", to: "bbb2222" } }),
      expect.anything(),
    );
  });

  it("doesn't move the head for a merged report", async () => {
    const result = await reportPullRequestStatus(checker(), scope, "bug1", {
      pullRequestUrl: PR, state: "merged", mergedInto: "main", inDefaultBranch: true, headSha: "bbb2222", mergeCommitSha: "ccc3333", note: "Merged into main.",
    });
    expect(result).toMatchObject({ status: 201, body: { report: { state: "merged", mergedInto: "main", inDefaultBranch: true, mergeCommitSha: "ccc3333" } } });
    expect(db.tx.bug.updateMany).not.toHaveBeenCalled();
  });

  it("answers 409 pr_mismatch for a report on another pull request", async () => {
    const result = await reportPullRequestStatus(checker(), scope, "bug1", openBody({ pullRequestUrl: "https://github.com/emerjent/ziki/pull/9" }));
    expect(result).toMatchObject({ status: 409, body: { error: "pr_mismatch", field: "pullRequestUrl" } });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("answers 409 no_pull_request when the issue links none", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ pullRequestUrl: null }));
    expect(await reportPullRequestStatus(checker(), scope, "bug1", openBody())).toMatchObject({ status: 409, body: { error: "no_pull_request" } });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("answers 404 for an issue outside the project", async () => {
    db.bug.findFirst.mockResolvedValue(null);
    expect(await reportPullRequestStatus(checker(), scope, "bug1", openBody())).toMatchObject({ status: 404, body: { error: "not_found" } });
  });

  it("refuses the claim holder's owner and the filer: 403 not_independent", async () => {
    for (const owner of ["cara", "ada"]) {
      expect(await reportPullRequestStatus(checker(owner, "manager"), scope, "bug1", openBody())).toMatchObject({ status: 403, body: { error: "not_independent" } });
    }
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses the owner a delivery on this pull request was by or for: 403 not_independent", async () => {
    db.delivery.findFirst.mockResolvedValue({ id: "d1" });
    expect(await reportPullRequestStatus(checker("gus"), scope, "bug1", openBody())).toMatchObject({ status: 403, body: { error: "not_independent" } });
    expect(db.delivery.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { bugId: "bug1", pullRequestUrl: PR, OR: [{ beneficiaryUserId: "gus" }, { agent: { ownerUserId: "gus" } }] },
    }));
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("answers 400 for a merged report that doesn't say whether the default branch contains it", async () => {
    const result = await reportPullRequestStatus(checker(), scope, "bug1", { pullRequestUrl: PR, state: "merged", mergedInto: "staging", note: "Merged." });
    expect(result).toMatchObject({ status: 400, body: { error: "invalid_request", field: "inDefaultBranch" } });
    expect(db.bug.findFirst).not.toHaveBeenCalled();
  });

  it("answers 400 for merge details on a report that isn't merged, and for a report with no note", async () => {
    expect(await reportPullRequestStatus(checker(), scope, "bug1", openBody({ inDefaultBranch: true }))).toMatchObject({ status: 400, body: { field: "state" } });
    expect(await reportPullRequestStatus(checker(), scope, "bug1", openBody({ note: "" }))).toMatchObject({ status: 400, body: { field: "note" } });
    expect(db.bug.findFirst).not.toHaveBeenCalled();
  });
});
