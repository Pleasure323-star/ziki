import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const tx = {
    bug: { updateMany: vi.fn() },
    testVerdict: { updateMany: vi.fn() },
    mergeReview: { updateMany: vi.fn() },
    delivery: { updateMany: vi.fn() },
    reviewOffer: { updateMany: vi.fn() },
  };
  return {
    bug: { findFirst: vi.fn() },
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    tx,
  };
});
const publish = vi.hoisted(() => vi.fn());
const audit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/agent-api/events", () => ({ publish }));
vi.mock("@/lib/agents/audit", () => ({ audit }));

import type { AgentContext } from "@/lib/agents/require-agent";
import { GitHubError, type GitHubClient, type PullRequest } from "@/lib/github/merge-pr";
import { isFormerNameOf } from "@/lib/github/former-repos";
import { repairPullRequestLink } from "./repair-pull-request";

const OLD = "https://github.com/Zedu-Endor/issue-tracker/pull/552";
const NEW = "https://github.com/emerjent/ziki/pull/552";
const scope = { tenantId: "t1", projectId: "p1" };
const manager = (ownerId = "dana", level: AgentContext["level"] = "manager"): AgentContext =>
  ({ agentId: `agent-${ownerId}`, name: ownerId, ownerId, tenantId: "t1", level, burst: false, keyId: "k" });

function bug(over: Record<string, unknown> = {}) {
  return {
    id: "bug1", status: "done", pullRequestUrl: OLD, pullRequestHeadSha: "old-head",
    reporterId: "ada", beneficiaryUserId: "ada", assigneeId: null, createdByAgent: null,
    project: { repoUrl: "https://github.com/emerjent/ziki", githubInstallationId: "inst" },
    claims: [{ status: "active", releasedAt: null, beneficiaryUserId: "cara", dispatcherUserId: null, agent: { ownerUserId: "cara" } }],
    ...over,
  };
}

const open: PullRequest = { merged: false, mergeable: true, headSha: "new-head", state: "open", baseRepo: "emerjent/ziki" };

function github(answer: Partial<PullRequest> | Error = {}) {
  const getPullRequest = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return { ...open, ...answer };
  });
  return { client: { getPullRequest } as unknown as GitHubClient, getPullRequest };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.bug.findFirst.mockResolvedValue(bug());
  db.tx.bug.updateMany.mockResolvedValue({ count: 1 });
  db.tx.testVerdict.updateMany.mockResolvedValue({ count: 2 });
  db.tx.mergeReview.updateMany.mockResolvedValue({ count: 1 });
  db.tx.delivery.updateMany.mockResolvedValue({ count: 1 });
  db.tx.reviewOffer.updateMany.mockResolvedValue({ count: 0 });
});

describe("former repository names", () => {
  it("knows emerjent/ziki's old names, in any case, and nothing else", () => {
    const ziki = { owner: "emerjent", repo: "ziki" };
    expect(isFormerNameOf({ owner: "Zedu-Endor", repo: "issue-tracker" }, ziki)).toBe(true);
    expect(isFormerNameOf({ owner: "zeduchat", repo: "Bug-Tracker" }, ziki)).toBe(true);
    expect(isFormerNameOf({ owner: "emerjent", repo: "bug-tracker" }, { owner: "Emerjent", repo: "Ziki" })).toBe(true);
    expect(isFormerNameOf({ owner: "someone", repo: "issue-tracker" }, ziki)).toBe(false);
    expect(isFormerNameOf({ owner: "Zedu-Endor", repo: "issue-tracker" }, { owner: "acme", repo: "app" })).toBe(false);
  });
});

describe("repairPullRequestLink (#repair-pr-link)", () => {
  it("moves the same pull request to the repository's current name, judgements and reviews with it", async () => {
    const gh = github();
    const result = await repairPullRequestLink(manager(), scope, "bug1", {}, () => gh.client);
    expect(result).toEqual({
      status: 200,
      body: {
        repaired: true, issueId: "bug1", previousPullRequestUrl: OLD, pullRequestUrl: NEW, pullRequestHeadSha: "old-head",
        samePullRequest: true, moved: { judgements: 2, mergeReviews: 1, deliveries: 1, reviewOffers: 0 },
      },
    });
    expect(gh.getPullRequest).toHaveBeenCalledWith({ owner: "emerjent", repo: "ziki", number: 552 });
    expect(db.tx.bug.updateMany).toHaveBeenCalledWith({
      where: { id: "bug1", pullRequestUrl: OLD },
      data: { pullRequestUrl: NEW, pullRequestHeadSha: "old-head" },
    });
    for (const table of [db.tx.testVerdict, db.tx.mergeReview, db.tx.delivery, db.tx.reviewOffer]) {
      expect(table.updateMany).toHaveBeenCalledWith({ where: { bugId: "bug1", pullRequestUrl: OLD }, data: { pullRequestUrl: NEW } });
    }
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-dana" }),
      "issue.pull_request_repaired",
      "bug:bug1",
      expect.objectContaining({ from: OLD, to: NEW, samePullRequest: true }),
      expect.objectContaining({ bugId: "bug1" }),
    );
    expect(publish.mock.calls[0][1]).toMatchObject({
      type: "issue.updated",
      payload: { changed: ["pullRequestUrl"], values: { pullRequestUrl: NEW }, previousPullRequestUrl: OLD, samePullRequest: true },
    });
  });

  it("accepts the same PR the manager names explicitly", async () => {
    const result = await repairPullRequestLink(manager(), scope, "bug1", { pullRequestUrl: NEW }, () => github().client);
    expect(result).toMatchObject({ status: 200, body: { samePullRequest: true } });
  });

  it("links a different pull request without moving the old judgements, which stop counting", async () => {
    const other = "https://github.com/emerjent/ziki/pull/700";
    const result = await repairPullRequestLink(manager(), scope, "bug1", { pullRequestUrl: other }, () => github().client);
    expect(result).toMatchObject({
      status: 200,
      body: { pullRequestUrl: other, pullRequestHeadSha: "new-head", samePullRequest: false, moved: { judgements: 0, mergeReviews: 0, deliveries: 0, reviewOffers: 0 } },
    });
    expect(db.tx.bug.updateMany.mock.calls[0][0].data).toEqual({ pullRequestUrl: other, pullRequestHeadSha: "new-head" });
    expect(db.tx.testVerdict.updateMany).not.toHaveBeenCalled();
    expect(db.tx.mergeReview.updateMany).not.toHaveBeenCalled();
  });

  it("treats a same-number PR from an unknown repository as a different PR", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ pullRequestUrl: "https://github.com/someone/fork/pull/552" }));
    const result = await repairPullRequestLink(manager(), scope, "bug1", {}, () => github().client);
    expect(result).toMatchObject({ status: 200, body: { pullRequestUrl: NEW, samePullRequest: false } });
    expect(db.tx.testVerdict.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["a working agent", manager("dana", "working"), bug(), github(), 403, "insufficient_level", undefined],
    ["not a PR URL", manager(), bug(), github(), 422, "invalid_url", "https://github.com/emerjent/ziki/issues/552"],
    ["an issue outside the project", manager(), null, github(), 404, "not_found", undefined],
    ["the filer's own manager", manager("ada"), bug(), github(), 403, "not_independent", undefined],
    ["the claim holder's own manager", manager("cara"), bug(), github(), 403, "not_independent", undefined],
    ["an issue with no link", manager(), bug({ pullRequestUrl: null }), github(), 409, "no_pull_request", undefined],
    ["a project with no repository", manager(), bug({ project: { repoUrl: null, githubInstallationId: "inst" } }), github(), 422, "no_repo", undefined],
    ["a PR in another repository", manager(), bug(), github(), 422, "wrong_repository", "https://github.com/acme/app/pull/552"],
    ["the link it has already", manager(), bug({ pullRequestUrl: NEW }), github(), 409, "already_current", undefined],
    ["a PR GitHub doesn't have", manager(), bug(), github(new GitHubError("Not Found", 404)), 422, "pr_not_found", undefined],
    ["GitHub not answering", manager(), bug(), github(new Error("boom")), 502, "github_error", undefined],
    ["a PR GitHub puts in another repository", manager(), bug(), github({ baseRepo: "acme/app" }), 422, "wrong_repository", undefined],
    ["an unparsable link and no PR named", manager(), bug({ pullRequestUrl: "PR 552" }), github(), 422, "invalid_url", undefined],
  ])("refuses %s", async (_label, agent, row, gh, status, error, url: string | undefined) => {
    db.bug.findFirst.mockResolvedValue(row);
    const result = await repairPullRequestLink(agent, scope, "bug1", url ? { pullRequestUrl: url } : {}, () => gh.client);
    expect(result).toMatchObject({ status, body: { error } });
    expect(db.tx.bug.updateMany).not.toHaveBeenCalled();
  });

  it("answers 503 when GitHub isn't configured for the project", async () => {
    expect(await repairPullRequestLink(manager(), scope, "bug1", {}, () => null)).toMatchObject({ status: 503, body: { error: "github_unavailable" } });
    expect(db.tx.bug.updateMany).not.toHaveBeenCalled();
  });

  it("changes nothing when the link changed meanwhile (409 status_changed)", async () => {
    db.tx.bug.updateMany.mockResolvedValue({ count: 0 });
    expect(await repairPullRequestLink(manager(), scope, "bug1", {}, () => github().client)).toMatchObject({ status: 409, body: { error: "status_changed" } });
    expect(db.tx.testVerdict.updateMany).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
