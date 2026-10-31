import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const tx = { bug: { findUnique: vi.fn() } };
  return {
    bug: { findFirst: vi.fn() },
    pullRequestReport: { findFirst: vi.fn() },
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    tx,
  };
});
const merge = vi.hoisted(() => ({
  mergeBugSelect: {},
  creditedDeliveryUsers: vi.fn(),
  countedReviewers: vi.fn(),
  finalizeResolved: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/merge", () => merge);

import type { AgentContext } from "@/lib/agents/require-agent";
import { reconcileMergedWork } from "./reconcile-merged";

const PR = "https://github.com/emerjent/ziki/pull/552";
const scope = { tenantId: "t1", projectId: "p1" };
const manager = (ownerId = "dana", level: AgentContext["level"] = "manager"): AgentContext =>
  ({ agentId: `agent-${ownerId}`, name: ownerId, ownerId, tenantId: "t1", level, burst: false, keyId: "k" });

/** A fix tested and accepted, delivered by Cara's agent, filed by Ada. */
function bug(over: Record<string, unknown> = {}) {
  return {
    id: "bug1", tenantId: "t1", projectId: "p1", status: "merge", substatus: "ready_to_merge",
    pullRequestUrl: PR, pullRequestHeadSha: "head-sha",
    assigneeId: null, beneficiaryUserId: "ada", reporterId: "ada", createdByAgentId: null, createdByAgent: null,
    project: { repoUrl: "https://github.com/emerjent/ziki.git" },
    claims: [{
      status: "active", claimedAt: new Date("2026-10-20T10:00:00Z"), releasedAt: null, agentId: "agent-cara",
      beneficiaryUserId: "cara", dispatcherUserId: null, agent: { ownerUserId: "cara", name: "cara" },
    }],
    ...over,
  };
}

/** The latest independent report on the pull request (#pr-reports): merged into main by default. */
function report(over: Record<string, unknown> = {}) {
  return {
    id: "rep1",
    bugId: "bug1",
    pullRequestUrl: PR,
    state: "merged",
    mergedInto: "main",
    inDefaultBranch: true,
    headSha: "head-sha",
    mergeCommitSha: "merge-sha",
    checks: "passing",
    mergeable: null,
    note: "Merged into main on GitHub.",
    agentId: "agent-erin",
    onBehalfOfUserId: "erin",
    createdAt: new Date("2026-10-30T09:00:00Z"),
    agent: { name: "erin's agent" },
    onBehalfOf: { name: "Erin" },
    ...over,
  };
}

const unmerged = { mergedInto: null, inDefaultBranch: null, mergeCommitSha: null };

beforeEach(() => {
  vi.clearAllMocks();
  db.bug.findFirst.mockResolvedValue(bug());
  db.pullRequestReport.findFirst.mockResolvedValue(report());
  db.tx.bug.findUnique.mockResolvedValue({ status: "merge", substatus: "ready_to_merge", pullRequestUrl: PR });
  merge.creditedDeliveryUsers.mockResolvedValue([]);
  merge.countedReviewers.mockResolvedValue({ reviewers: ["erin", "finn"], acceptedHeadSha: "head-sha" });
});

describe("reconcileMergedWork (#reconcile-merged, #pr-reports)", () => {
  it("makes work the latest report says is merged into the default branch Live, with the PR, merge commit, branch and report on the record", async () => {
    const result = await reconcileMergedWork(manager(), scope, "bug1");
    expect(result).toMatchObject({
      status: 200,
      body: {
        resolved: true, reconciled: true, issueId: "bug1", previousStatus: "merge", pullRequestUrl: PR,
        mergeCommitSha: "merge-sha", mergedInto: "main", solverUserId: "cara", rewardedReviewerUserIds: ["erin", "finn"],
        pullRequestState: {
          id: "rep1", state: "merged", mergedInto: "main", inDefaultBranch: true, mergeCommitSha: "merge-sha",
          reportedBy: { agentId: "agent-erin", agentName: "erin's agent", userId: "erin", name: "Erin" },
        },
      },
    });
    expect(db.pullRequestReport.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { bugId: "bug1", pullRequestUrl: PR } }));
    expect(merge.finalizeResolved).toHaveBeenCalledTimes(1);
    const [, input] = merge.finalizeResolved.mock.calls[0];
    expect(input).toMatchObject({
      solverUserId: "cara",
      rewardedReviewerUserIds: ["erin", "finn"],
      acceptedHeadSha: "head-sha",
      mergeCommitSha: "merge-sha",
      record: { via: "reconcile_merged", reconciled: true, mergedInto: "main", pullRequestReportId: "rep1", reportedByAgentId: "agent-erin" },
      eventRecord: { via: "reconcile_merged", reconciled: true, mergedInto: "main", pullRequestReportId: "rep1" },
    });
    expect(input.agent).toMatchObject({ agentId: "agent-dana" });
    expect(db.bug.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "bug1", ...scope, isDeleted: false } }));
  });

  it("credits the person a delivery on the holder's behalf names when no claim stands", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ claims: [] }));
    merge.creditedDeliveryUsers.mockResolvedValue(["gus"]);
    const result = await reconcileMergedWork(manager(), scope, "bug1");
    expect(result.status).toBe(200);
    expect(merge.finalizeResolved.mock.calls[0][1]).toMatchObject({ solverUserId: "gus", claim: null });
  });

  it.each(["in_progress", "done", "merge"])("reconciles from %s", async (status) => {
    db.bug.findFirst.mockResolvedValue(bug({ status }));
    db.tx.bug.findUnique.mockResolvedValue({ status, pullRequestUrl: PR });
    expect((await reconcileMergedWork(manager(), scope, "bug1", PR)).status).toBe(200);
  });

  it("reconciles a pull request merged into staging once the report says the default branch contains it", async () => {
    db.pullRequestReport.findFirst.mockResolvedValue(report({ mergedInto: "staging", inDefaultBranch: true }));
    const result = await reconcileMergedWork(manager(), scope, "bug1");
    expect(result).toMatchObject({ status: 200, body: { mergedInto: "staging", mergeCommitSha: "merge-sha" } });
    expect(merge.finalizeResolved.mock.calls[0][1]).toMatchObject({
      record: { via: "reconcile_merged", mergedInto: "staging" },
      eventRecord: { mergedInto: "staging" },
    });
  });

  it.each([
    ["a working agent", manager("dana", "working"), bug(), report(), 403, "insufficient_level", undefined],
    ["not a PR URL", manager(), bug(), report(), 422, "invalid_url", "https://github.com/emerjent/ziki/issues/552"],
    ["an issue outside the project", manager(), null, report(), 404, "not_found", undefined],
    ["an issue already Live", manager(), bug({ status: "resolved", substatus: "on_dev" }), report(), 409, "already_resolved", undefined],
    ["the filer's own manager", manager("ada"), bug(), report(), 403, "not_independent", undefined],
    ["the claim holder's own manager", manager("cara"), bug(), report(), 403, "not_independent", undefined],
    ["work still Open", manager(), bug({ status: "open", substatus: "open" }), report(), 409, "not_in_review", undefined],
    ["work awaiting confirmation", manager(), bug({ status: "open", substatus: "requires_confirmation" }), report(), 409, "not_in_review", undefined],
    ["no linked PR", manager(), bug({ pullRequestUrl: null }), report(), 409, "no_pull_request", undefined],
    ["a different PR than the linked one", manager(), bug(), report(), 409, "pr_mismatch", "https://github.com/emerjent/ziki/pull/9"],
    ["no report yet", manager(), bug(), null, 409, "needs_pr_report", undefined],
    ["a report on another pull request", manager(), bug(), report({ pullRequestUrl: "https://github.com/emerjent/ziki/pull/9" }), 409, "needs_pr_report", undefined],
    ["a merged report that doesn't say whether the default branch contains it", manager(), bug(), report({ inDefaultBranch: null }), 409, "needs_pr_report", undefined],
    ["a merge into staging not yet in the default branch", manager(), bug(), report({ mergedInto: "staging", inDefaultBranch: false }), 409, "awaiting_release", undefined],
    ["a pull request reported missing", manager(), bug(), report({ state: "not_found", ...unmerged }), 409, "pr_broken", undefined],
    ["a pull request reported closed without merging", manager(), bug(), report({ state: "closed", ...unmerged }), 409, "pr_broken", undefined],
    ["a link under an old repository name", manager(), bug({ pullRequestUrl: "https://github.com/Zedu-Endor/issue-tracker/pull/552" }), report(), 409, "pr_broken", undefined],
    ["a link outside the project's repository", manager(), bug({ pullRequestUrl: "https://github.com/someone/fork/pull/552" }), report(), 409, "pr_broken", undefined],
    ["a pull request reported open", manager(), bug(), report({ state: "open", ...unmerged }), 409, "not_merged", undefined],
  ])("refuses %s", async (_label, agent, row, latest, status, error, url: string | undefined) => {
    db.bug.findFirst.mockResolvedValue(row);
    db.pullRequestReport.findFirst.mockResolvedValue(latest);
    const result = await reconcileMergedWork(agent, scope, "bug1", url);
    expect(result).toMatchObject({ status, body: { error } });
    expect(merge.finalizeResolved).not.toHaveBeenCalled();
  });

  it("reconciles an In progress issue whose PR is already merged into main (production #682)", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ status: "in_progress", substatus: "in_progress" }));
    db.tx.bug.findUnique.mockResolvedValue({ status: "in_progress", substatus: "in_progress", pullRequestUrl: PR });
    const result = await reconcileMergedWork(manager(), scope, "bug1");
    expect(result).toMatchObject({ status: 200, body: { previousStatus: "in_progress", mergedInto: "main" } });
    expect(merge.finalizeResolved).toHaveBeenCalledTimes(1);
    expect(merge.finalizeResolved.mock.calls[0][1]).toMatchObject({ solverUserId: "cara", mergeCommitSha: "merge-sha" });
  });

  it("names the branch when the fix waits for a release", async () => {
    db.pullRequestReport.findFirst.mockResolvedValue(report({ mergedInto: "staging", inDefaultBranch: false }));
    const result = await reconcileMergedWork(manager(), scope, "bug1");
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: "awaiting_release" });
    expect((result.body as { message: string }).message).toContain("Merged into \"staging\"");
    expect((result.body as { message: string }).message).toContain("isn't released to the default branch yet");
  });

  it("changes nothing when the issue moved or was relinked meanwhile (409 status_changed)", async () => {
    db.tx.bug.findUnique.mockResolvedValue({ status: "resolved", substatus: "on_dev", pullRequestUrl: PR });
    expect(await reconcileMergedWork(manager(), scope, "bug1")).toMatchObject({ status: 409, body: { error: "status_changed" } });
    db.tx.bug.findUnique.mockResolvedValue({ status: "merge", substatus: "ready_to_merge", pullRequestUrl: "https://github.com/emerjent/ziki/pull/9" });
    expect(await reconcileMergedWork(manager(), scope, "bug1")).toMatchObject({ status: 409, body: { error: "status_changed" } });
    expect(merge.finalizeResolved).not.toHaveBeenCalled();
  });
});
