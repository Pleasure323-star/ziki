import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const tx = {
    bug: { updateMany: vi.fn() },
    bugActivity: { create: vi.fn() },
    issueClaim: { updateMany: vi.fn() },
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

import { readAgentResolution } from "@/lib/agent-resolution";
import type { AgentContext } from "@/lib/agents/require-agent";
import type { GitHubClient } from "@/lib/github/merge-pr";
import { resolveMergedFix } from "./resolve";

const PR = "https://github.com/acme/app/pull/12";
const scope = { tenantId: "t1", projectId: "p1" };
const agent = (ownerId = "owner", level: AgentContext["level"] = "working"): AgentContext =>
  ({ agentId: "a1", name: "Charles Xavier", ownerId, tenantId: "t1", level, burst: false, keyId: "k" });

function bug(over: Record<string, unknown> = {}) {
  return {
    id: "bug1", status: "in_progress", assigneeId: "owner", reporterId: "rep", pullRequestUrl: null,
    project: { repoUrl: "https://github.com/acme/app", githubInstallationId: "inst" },
    claims: [],
    ...over,
  };
}

function github(merged = true, fails = false) {
  const getPullRequest = vi.fn(async () => {
    if (fails) throw new Error("boom");
    return { merged, mergeable: true, headSha: "abc" };
  });
  return { client: { getPullRequest } as unknown as GitHubClient, getPullRequest };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.tx.bug.updateMany.mockResolvedValue({ count: 1 });
});

describe("resolveMergedFix (Ziki #515)", () => {
  it("lets an agent of any class resolve a merged fix, links the PR and writes no points", async () => {
    db.bug.findFirst.mockResolvedValue(bug());
    const gh = github();
    for (const level of ["working", "manager", "merger"] as const) {
      db.tx.bug.updateMany.mockClear();
      const result = await resolveMergedFix(agent("owner", level), scope, "bug1", PR, () => gh.client);
      expect(result).toEqual({ status: 200, body: { resolved: true, issueId: "bug1", previousStatus: "in_progress", pullRequestUrl: PR } });
      expect(db.tx.bug.updateMany).toHaveBeenCalledWith({
        where: { id: "bug1", status: "in_progress", pullRequestUrl: null },
        data: { status: "resolved", pullRequestUrl: PR },
      });
    }
    expect(gh.getPullRequest).toHaveBeenCalledWith({ owner: "acme", repo: "app", number: 12 });
    expect(db.bug.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "bug1", ...scope, isDeleted: false } }));
  });

  it("records who resolved it and with which PR, so the page can offer a reopen", async () => {
    db.bug.findFirst.mockResolvedValue(bug());
    await resolveMergedFix(agent(), scope, "bug1", PR, () => github().client);
    const metadata = db.tx.bugActivity.create.mock.calls[0][0].data.metadata;
    expect(metadata).toMatchObject({ field: "status", from: "in_progress", to: "resolved", via: "agent_resolve", agentId: "a1", pullRequestUrl: PR });
    expect(readAgentResolution(metadata)).toEqual({ agentName: "Charles Xavier", pullRequestUrl: PR, previousStatus: "in_progress" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ agentId: "a1" }), "issue.resolved", "bug:bug1", { from: "in_progress", pullRequestUrl: PR }, expect.objectContaining({ bugId: "bug1" }));
    const updated = publish.mock.calls.find((c) => c[1].type === "issue.updated")?.[1];
    expect(updated.payload).toMatchObject({ issueId: "bug1", changed: ["status"], values: { status: "resolved" }, source: "agent", agentId: "a1" });
  });

  it("releases an active claim and publishes the release", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ assigneeId: null, claims: [{ id: "c1", agentId: "a9", beneficiaryUserId: "owner" }] }));
    expect((await resolveMergedFix(agent(), scope, "bug1", PR, () => github().client)).status).toBe(200);
    expect(db.tx.issueClaim.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "released", releaseReason: "resolved" }) }));
    expect(publish.mock.calls.map((c) => c[1].type)).toEqual(["claim.released", "issue.updated"]);
  });

  it("clears the boost on a boosted issue and logs the unboost (#256)", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ isBoosted: true }));
    await resolveMergedFix(agent(), scope, "bug1", PR, () => github().client);
    expect(db.tx.bug.updateMany.mock.calls[0][0].data).toEqual({ status: "resolved", isBoosted: false, boostedAt: null, pullRequestUrl: PR });
    expect(db.tx.bugActivity.create.mock.calls.map((c) => c[0].data.type)).toEqual(["status_changed", "unboosted"]);
  });

  it("keeps an already linked PR instead of overwriting it", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ pullRequestUrl: PR }));
    await resolveMergedFix(agent(), scope, "bug1", PR, () => github().client);
    expect(db.tx.bug.updateMany.mock.calls[0][0].data).toEqual({ status: "resolved" });
    // Only if nobody relinked it since the read.
    expect(db.tx.bug.updateMany.mock.calls[0][0].where).toEqual({ id: "bug1", status: "in_progress", pullRequestUrl: PR });
  });

  it("accepts the reporter's agent too", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ assigneeId: "someone", reporterId: "owner" }));
    expect((await resolveMergedFix(agent(), scope, "bug1", PR, () => github().client)).status).toBe(200);
  });

  it("refuses an agent whose owner isn't connected to the issue", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ assigneeId: "someone", reporterId: "rep" }));
    const gh = github();
    const result = await resolveMergedFix(agent("stranger"), scope, "bug1", PR, () => gh.client);
    expect(result).toMatchObject({ status: 403, body: { error: "not_connected" } });
    expect(gh.getPullRequest).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("hands a manager not connected to the issue to the reconcile path, with its stricter rules (#reconcile-merged)", async () => {
    // In progress is not work in review, so the reconcile refuses it; the connected path would have resolved it.
    db.bug.findFirst.mockResolvedValue(bug({ assigneeId: "someone", reporterId: "rep" }));
    const gh = github();
    const result = await resolveMergedFix(agent("stranger", "manager"), scope, "bug1", PR, () => gh.client);
    expect(result).toMatchObject({ status: 409, body: { error: "not_in_review" } });
    expect(gh.getPullRequest).not.toHaveBeenCalled();
    expect(db.tx.bug.updateMany).not.toHaveBeenCalled();
  });

  it("uses the linked pull request when none is sent, and asks for one when none is linked", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ pullRequestUrl: PR }));
    expect((await resolveMergedFix(agent(), scope, "bug1", undefined, () => github().client)).status).toBe(200);
    db.bug.findFirst.mockResolvedValue(bug());
    expect(await resolveMergedFix(agent(), scope, "bug1", undefined, () => github().client)).toMatchObject({ status: 409, body: { error: "no_pull_request" } });
  });

  it.each([
    ["not a PR URL", "https://github.com/acme/app/issues/12", bug(), github(), 422, "invalid_url"],
    ["an issue outside the key's project", PR, null, github(), 404, "not_found"],
    ["an issue already resolved", PR, bug({ status: "resolved" }), github(), 409, "already_resolved"],
    ["an issue already closed", PR, bug({ status: "closed" }), github(), 409, "already_resolved"],
    ["a different PR than the linked one", PR, bug({ pullRequestUrl: "https://github.com/acme/app/pull/99" }), github(), 409, "pr_mismatch"],
    ["a project without a repo", PR, bug({ project: { repoUrl: null, githubInstallationId: "inst" } }), github(), 422, "no_repo"],
    ["a PR in another repo", "https://github.com/other/app/pull/12", bug(), github(), 422, "wrong_repo"],
    ["a PR that isn't merged", PR, bug(), github(false), 409, "not_merged"],
    ["GitHub failing", PR, bug(), github(true, true), 502, "github_error"],
  ])("refuses %s and changes nothing", async (_name, url, found, gh, status, error) => {
    db.bug.findFirst.mockResolvedValue(found);
    const result = await resolveMergedFix(agent(), scope, "bug1", url as string, () => (gh as ReturnType<typeof github>).client);
    expect(result).toMatchObject({ status, body: { error } });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses when the project's GitHub App isn't installed", async () => {
    db.bug.findFirst.mockResolvedValue(bug());
    expect(await resolveMergedFix(agent(), scope, "bug1", PR, () => null)).toMatchObject({ status: 409, body: { error: "github_unavailable" } });
  });

  it("records and publishes nothing when the status changed after it was read", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ claims: [{ id: "c1", agentId: "a9", beneficiaryUserId: "owner" }] }));
    db.tx.bug.updateMany.mockResolvedValue({ count: 0 });
    expect(await resolveMergedFix(agent(), scope, "bug1", PR, () => github().client)).toMatchObject({ status: 409, body: { error: "status_changed" } });
    expect(db.tx.bugActivity.create).not.toHaveBeenCalled();
    expect(db.tx.issueClaim.updateMany).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("readAgentResolution (Ziki #515)", () => {
  it("only reads an agent resolve, and reopens anything but in_progress as open", () => {
    const base = { via: "agent_resolve", to: "resolved", agentName: "X", pullRequestUrl: PR };
    expect(readAgentResolution({ ...base, from: "open" })?.previousStatus).toBe("open");
    expect(readAgentResolution({ ...base, from: "in_progress" })?.previousStatus).toBe("in_progress");
    expect(readAgentResolution({ ...base, from: "weird" })?.previousStatus).toBe("open");
    expect(readAgentResolution({ ...base, via: "github_pull_request_merged" })).toBeNull();
    expect(readAgentResolution({ field: "status", from: "open", to: "resolved" })).toBeNull();
    expect(readAgentResolution(null)).toBeNull();
  });
});
