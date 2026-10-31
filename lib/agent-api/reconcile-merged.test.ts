import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const tx = { bug: { findUnique: vi.fn() } };
  return {
    bug: { findFirst: vi.fn() },
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
import type { GitHubClient, PullRequest } from "@/lib/github/merge-pr";
import { reconcileMergedWork } from "./reconcile-merged";

const PR = "https://github.com/emerjent/ziki/pull/552";
const scope = { tenantId: "t1", projectId: "p1" };
const manager = (ownerId = "dana", level: AgentContext["level"] = "manager"): AgentContext =>
  ({ agentId: `agent-${ownerId}`, name: ownerId, ownerId, tenantId: "t1", level, burst: false, keyId: "k" });

/** A fix tested and accepted, delivered by Cara's agent, filed by Ada. */
function bug(over: Record<string, unknown> = {}) {
  return {
    id: "bug1", tenantId: "t1", projectId: "p1", status: "ready_to_merge",
    pullRequestUrl: PR, pullRequestHeadSha: "head-sha",
    assigneeId: null, beneficiaryUserId: "ada", reporterId: "ada", createdByAgentId: null, createdByAgent: null,
    project: { repoUrl: "https://github.com/emerjent/ziki.git", githubInstallationId: "inst" },
    claims: [{
      status: "active", claimedAt: new Date("2026-10-20T10:00:00Z"), releasedAt: null, agentId: "agent-cara",
      beneficiaryUserId: "cara", dispatcherUserId: null, agent: { ownerUserId: "cara", name: "cara" },
    }],
    ...over,
  };
}

const merged: PullRequest = {
  merged: true, mergeable: true, headSha: "head-sha", state: "closed",
  baseRef: "main", baseRepo: "emerjent/ziki", defaultBranch: "main", mergeCommitSha: "merge-sha",
};

function github(pr: Partial<PullRequest> = {}, fails = false, compare?: string | Error) {
  const getPullRequest = vi.fn(async () => {
    if (fails) throw new Error("boom");
    return { ...merged, ...pr };
  });
  const compareCommits = vi.fn(async () => {
    if (compare instanceof Error) throw compare;
    return { status: compare ?? "ahead" };
  });
  const client = (compare === undefined ? { getPullRequest } : { getPullRequest, compareCommits }) as unknown as GitHubClient;
  return { client, getPullRequest, compareCommits };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.bug.findFirst.mockResolvedValue(bug());
  db.tx.bug.findUnique.mockResolvedValue({ status: "ready_to_merge", pullRequestUrl: PR });
  merge.creditedDeliveryUsers.mockResolvedValue([]);
  merge.countedReviewers.mockResolvedValue({ reviewers: ["erin", "finn"], acceptedHeadSha: "head-sha" });
});

describe("reconcileMergedWork (#reconcile-merged)", () => {
  it("makes merged work Live the way the admin merge does, with the PR, merge commit and branch on the record", async () => {
    const gh = github();
    const result = await reconcileMergedWork(manager(), scope, "bug1", undefined, () => gh.client);
    expect(result).toEqual({
      status: 200,
      body: {
        resolved: true, reconciled: true, issueId: "bug1", previousStatus: "ready_to_merge", pullRequestUrl: PR,
        mergeCommitSha: "merge-sha", baseBranch: "main", releasedToDefault: false, solverUserId: "cara", rewardedReviewerUserIds: ["erin", "finn"],
      },
    });
    expect(gh.getPullRequest).toHaveBeenCalledWith({ owner: "emerjent", repo: "ziki", number: 552 });
    expect(merge.finalizeResolved).toHaveBeenCalledTimes(1);
    const [, input] = merge.finalizeResolved.mock.calls[0];
    expect(input).toMatchObject({
      solverUserId: "cara",
      rewardedReviewerUserIds: ["erin", "finn"],
      acceptedHeadSha: "head-sha",
      mergeCommitSha: "merge-sha",
      record: { via: "reconcile_merged", reconciled: true, baseBranch: "main" },
    });
    expect(input.agent).toMatchObject({ agentId: "agent-dana" });
    expect(db.bug.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "bug1", ...scope, isDeleted: false } }));
  });

  it("credits the person a delivery on the holder's behalf names when no claim stands", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ claims: [] }));
    merge.creditedDeliveryUsers.mockResolvedValue(["gus"]);
    const result = await reconcileMergedWork(manager(), scope, "bug1", undefined, () => github().client);
    expect(result.status).toBe(200);
    expect(merge.finalizeResolved.mock.calls[0][1]).toMatchObject({ solverUserId: "gus", claim: null });
  });

  it.each(["in_progress", "delivered", "done", "ready_to_merge"])("reconciles from %s", async (status) => {
    db.bug.findFirst.mockResolvedValue(bug({ status }));
    db.tx.bug.findUnique.mockResolvedValue({ status, pullRequestUrl: PR });
    expect((await reconcileMergedWork(manager(), scope, "bug1", PR, () => github().client)).status).toBe(200);
  });

  it.each([
    ["a working agent", manager("dana", "working"), bug(), github(), 403, "insufficient_level", undefined],
    ["not a PR URL", manager(), bug(), github(), 422, "invalid_url", "https://github.com/emerjent/ziki/issues/552"],
    ["an issue outside the project", manager(), null, github(), 404, "not_found", undefined],
    ["an issue already Live", manager(), bug({ status: "resolved" }), github(), 409, "already_resolved", undefined],
    ["the filer's own manager", manager("ada"), bug(), github(), 403, "not_independent", undefined],
    ["the claim holder's own manager", manager("cara"), bug(), github(), 403, "not_independent", undefined],
    ["work still Open", manager(), bug({ status: "open" }), github(), 409, "not_in_review", undefined],
    ["work awaiting confirmation", manager(), bug({ status: "requires_confirmation" }), github(), 409, "not_in_review", undefined],
    ["no linked PR", manager(), bug({ pullRequestUrl: null }), github(), 409, "no_pull_request", undefined],
    ["a different PR than the linked one", manager(), bug(), github(), 409, "pr_mismatch", "https://github.com/emerjent/ziki/pull/9"],
    ["a project with no repository", manager(), bug({ project: { repoUrl: null, githubInstallationId: "inst" } }), github(), 422, "no_repo", undefined],
    ["a link under an old repository name", manager(), bug({ pullRequestUrl: "https://github.com/Zedu-Endor/issue-tracker/pull/552" }), github(), 422, "wrong_repository", undefined],
    ["GitHub not answering", manager(), bug(), github({}, true), 502, "github_error", undefined],
    ["an unmerged PR", manager(), bug(), github({ merged: false, mergeCommitSha: null }), 409, "not_merged", undefined],
    ["a merge with no merge commit", manager(), bug(), github({ mergeCommitSha: null }), 409, "not_merged", undefined],
    ["a merge into another repository", manager(), bug(), github({ baseRepo: "someone/fork" }), 422, "wrong_repository", undefined],
    ["a merge into staging not yet in main", manager(), bug(), github({ baseRef: "staging" }, false, "ahead"), 409, "awaiting_release", undefined],
    ["a merge into staging that diverged from main", manager(), bug(), github({ baseRef: "staging" }, false, "diverged"), 409, "awaiting_release", undefined],
    ["a merge into staging when the client can't compare", manager(), bug(), github({ baseRef: "staging" }), 409, "awaiting_release", undefined],
    ["a merge into staging when the compare fails", manager(), bug(), github({ baseRef: "staging" }, false, new Error("boom")), 502, "github_error", undefined],
    ["a branch GitHub didn't name", manager(), bug(), github({ baseRef: undefined }), 409, "wrong_branch", undefined],
  ])("refuses %s", async (_label, agent, row, gh, status, error, url: string | undefined) => {
    db.bug.findFirst.mockResolvedValue(row);
    const result = await reconcileMergedWork(agent, scope, "bug1", url, () => gh.client);
    expect(result).toMatchObject({ status, body: { error } });
    expect(merge.finalizeResolved).not.toHaveBeenCalled();
  });

  it("reconciles an In progress issue whose PR is already merged into main (production #682)", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ status: "in_progress" }));
    db.tx.bug.findUnique.mockResolvedValue({ status: "in_progress", pullRequestUrl: PR });
    const result = await reconcileMergedWork(manager(), scope, "bug1", undefined, () => github().client);
    expect(result).toMatchObject({ status: 200, body: { previousStatus: "in_progress", baseBranch: "main" } });
    expect(merge.finalizeResolved).toHaveBeenCalledTimes(1);
    expect(merge.finalizeResolved.mock.calls[0][1]).toMatchObject({ solverUserId: "cara", mergeCommitSha: "merge-sha" });
  });

  it.each(["behind", "identical"])("reconciles a PR merged into staging once main contains it (compare %s)", async (status) => {
    const gh = github({ baseRef: "staging" }, false, status);
    const result = await reconcileMergedWork(manager(), scope, "bug1", undefined, () => gh.client);
    expect(result).toMatchObject({ status: 200, body: { baseBranch: "staging", releasedToDefault: true, mergeCommitSha: "merge-sha" } });
    expect(gh.compareCommits).toHaveBeenCalledWith({ owner: "emerjent", repo: "ziki" }, "main", "merge-sha");
    expect(merge.finalizeResolved.mock.calls[0][1]).toMatchObject({
      record: { via: "reconcile_merged", baseBranch: "staging", releasedToDefault: true },
      eventRecord: { baseBranch: "staging", releasedToDefault: true },
    });
  });

  it("names the branch when the fix waits for a release", async () => {
    const result = await reconcileMergedWork(manager(), scope, "bug1", undefined, () => github({ baseRef: "staging" }, false, "ahead").client);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: "awaiting_release" });
    expect((result.body as { message: string }).message).toContain("merged into \"staging\"");
    expect((result.body as { message: string }).message).toContain("once staging is released to main");
  });

  it("does not compare when the PR was merged into the default branch", async () => {
    const gh = github({}, false, "ahead");
    expect((await reconcileMergedWork(manager(), scope, "bug1", undefined, () => gh.client)).status).toBe(200);
    expect(gh.compareCommits).not.toHaveBeenCalled();
  });

  it("answers 503 when GitHub isn't configured for the project, without asking it", async () => {
    const result = await reconcileMergedWork(manager(), scope, "bug1", undefined, () => null);
    expect(result).toMatchObject({ status: 503, body: { error: "github_unavailable" } });
    expect(merge.finalizeResolved).not.toHaveBeenCalled();
  });

  it("answers 503 by default when the GitHub App has no credentials on this server", async () => {
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    try {
      expect(await reconcileMergedWork(manager(), scope, "bug1")).toMatchObject({ status: 503, body: { error: "github_unavailable" } });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("changes nothing when the issue moved or was relinked meanwhile (409 status_changed)", async () => {
    db.tx.bug.findUnique.mockResolvedValue({ status: "resolved", pullRequestUrl: PR });
    expect(await reconcileMergedWork(manager(), scope, "bug1", undefined, () => github().client)).toMatchObject({ status: 409, body: { error: "status_changed" } });
    db.tx.bug.findUnique.mockResolvedValue({ status: "ready_to_merge", pullRequestUrl: "https://github.com/emerjent/ziki/pull/9" });
    expect(await reconcileMergedWork(manager(), scope, "bug1", undefined, () => github().client)).toMatchObject({ status: 409, body: { error: "status_changed" } });
    expect(merge.finalizeResolved).not.toHaveBeenCalled();
  });
});
