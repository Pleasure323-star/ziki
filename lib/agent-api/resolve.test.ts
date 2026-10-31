import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const tx = {
    bug: { updateMany: vi.fn() },
    bugActivity: { create: vi.fn() },
    issueClaim: { updateMany: vi.fn() },
  };
  return {
    bug: { findFirst: vi.fn() },
    pullRequestReport: { findFirst: vi.fn() },
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
import { resolveMergedFix } from "./resolve";

const PR = "https://github.com/acme/app/pull/12";
const scope = { tenantId: "t1", projectId: "p1" };
const agent = (ownerId = "owner", level: AgentContext["level"] = "working"): AgentContext =>
  ({ agentId: "a1", name: "Charles Xavier", ownerId, tenantId: "t1", level, burst: false, keyId: "k" });

function bug(over: Record<string, unknown> = {}) {
  return {
    id: "bug1", status: "in_progress", substatus: "in_progress", assigneeId: "owner", reporterId: "rep", pullRequestUrl: PR, pullRequestHeadSha: "abc1234",
    project: { repoUrl: "https://github.com/acme/app" },
    claims: [],
    ...over,
  };
}

/** The latest independent report on the linked pull request (#pr-reports): merged into main by default. */
function report(over: Record<string, unknown> = {}) {
  return {
    id: "rep1",
    bugId: "bug1",
    pullRequestUrl: PR,
    state: "merged",
    mergedInto: "main",
    inDefaultBranch: true,
    headSha: "abc1234",
    mergeCommitSha: "def5678",
    checks: "passing",
    mergeable: null,
    note: "Merged into main.",
    agentId: "a7",
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
  db.tx.bug.updateMany.mockResolvedValue({ count: 1 });
  db.pullRequestReport.findFirst.mockResolvedValue(report());
});

describe("resolveMergedFix (Ziki #515, #pr-reports)", () => {
  it("lets an agent of any class resolve a fix reported merged into the default branch, and writes no points", async () => {
    db.bug.findFirst.mockResolvedValue(bug());
    for (const level of ["working", "manager", "merger"] as const) {
      db.tx.bug.updateMany.mockClear();
      const result = await resolveMergedFix(agent("owner", level), scope, "bug1", PR);
      expect(result).toEqual({ status: 200, body: { resolved: true, issueId: "bug1", previousStatus: "in_progress", previousSubstatus: "in_progress", status: "resolved", substatus: "on_dev", pullRequestUrl: PR } });
      expect(db.tx.bug.updateMany).toHaveBeenCalledWith({
        // Only if nobody relinked it or moved it since the read.
        where: { id: "bug1", substatus: "in_progress", pullRequestUrl: PR },
        data: { status: "resolved", substatus: "on_dev" },
      });
    }
    expect(db.pullRequestReport.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { bugId: "bug1", pullRequestUrl: PR } }));
    expect(db.bug.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "bug1", ...scope, isDeleted: false } }));
  });

  it("records who resolved it, with which PR and report, so the page can offer a reopen", async () => {
    db.bug.findFirst.mockResolvedValue(bug());
    await resolveMergedFix(agent(), scope, "bug1", PR);
    const metadata = db.tx.bugActivity.create.mock.calls[0][0].data.metadata;
    expect(metadata).toMatchObject({ field: "status", from: "in_progress", to: "on_dev", via: "agent_resolve", agentId: "a1", pullRequestUrl: PR, pullRequestReportId: "rep1" });
    expect(readAgentResolution(metadata)).toEqual({ agentName: "Charles Xavier", pullRequestUrl: PR, previousStatus: "in_progress" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "a1" }),
      "issue.resolved",
      "bug:bug1",
      { from: "in_progress", pullRequestUrl: PR, pullRequestReportId: "rep1" },
      expect.objectContaining({ bugId: "bug1" }),
    );
    const updated = publish.mock.calls.find((c) => c[1].type === "issue.updated")?.[1];
    expect(updated.payload).toMatchObject({ issueId: "bug1", changed: ["status", "substatus"], values: { status: "resolved", substatus: "on_dev" }, source: "agent", agentId: "a1" });
  });

  it("releases an active claim and publishes the release", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ assigneeId: null, claims: [{ id: "c1", agentId: "a9", beneficiaryUserId: "owner" }] }));
    expect((await resolveMergedFix(agent(), scope, "bug1", PR)).status).toBe(200);
    expect(db.tx.issueClaim.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "released", releaseReason: "resolved" }) }));
    expect(publish.mock.calls.map((c) => c[1].type)).toEqual(["claim.released", "issue.updated"]);
  });

  it("clears the boost on a boosted issue and logs the unboost (#256)", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ isBoosted: true }));
    await resolveMergedFix(agent(), scope, "bug1", PR);
    expect(db.tx.bug.updateMany.mock.calls[0][0].data).toEqual({ status: "resolved", substatus: "on_dev", isBoosted: false, boostedAt: null });
    expect(db.tx.bugActivity.create.mock.calls.map((c) => c[0].data.type)).toEqual(["status_changed", "unboosted"]);
  });

  it("accepts the reporter's agent too", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ assigneeId: "someone", reporterId: "owner" }));
    expect((await resolveMergedFix(agent(), scope, "bug1", PR)).status).toBe(200);
  });

  it("resolves on the report alone when the project names no repository", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ project: { repoUrl: null } }));
    expect((await resolveMergedFix(agent(), scope, "bug1", PR)).status).toBe(200);
  });

  it("refuses an agent whose owner isn't connected to the issue", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ assigneeId: "someone", reporterId: "rep" }));
    const result = await resolveMergedFix(agent("stranger"), scope, "bug1", PR);
    expect(result).toMatchObject({ status: 403, body: { error: "not_connected" } });
    expect(db.pullRequestReport.findFirst).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("hands a manager not connected to the issue to the reconcile path, with its stricter rules (#reconcile-merged)", async () => {
    // Open is not a step merged work is left at, so the reconcile refuses it; the connected path would have resolved it.
    db.bug.findFirst.mockResolvedValue(bug({ assigneeId: "someone", reporterId: "rep", status: "open", substatus: "open" }));
    const result = await resolveMergedFix(agent("stranger", "manager"), scope, "bug1", PR);
    expect(result).toMatchObject({ status: 409, body: { error: "not_in_review" } });
    expect(db.pullRequestReport.findFirst).not.toHaveBeenCalled();
    expect(db.tx.bug.updateMany).not.toHaveBeenCalled();
  });

  it("uses the linked pull request when none is sent, and refuses when none is linked, even with one sent", async () => {
    db.bug.findFirst.mockResolvedValue(bug());
    expect((await resolveMergedFix(agent(), scope, "bug1")).status).toBe(200);
    db.bug.findFirst.mockResolvedValue(bug({ pullRequestUrl: null }));
    expect(await resolveMergedFix(agent(), scope, "bug1")).toMatchObject({ status: 409, body: { error: "no_pull_request" } });
    // A sent pull request is not linked onto an issue that has none.
    expect(await resolveMergedFix(agent(), scope, "bug1", PR)).toMatchObject({ status: 409, body: { error: "no_pull_request" } });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not a PR URL", "https://github.com/acme/app/issues/12", bug(), report(), 422, "invalid_url"],
    ["an issue outside the key's project", PR, null, report(), 404, "not_found"],
    ["an issue already resolved", PR, bug({ status: "resolved", substatus: "on_dev" }), report(), 409, "already_resolved"],
    ["an issue already closed", PR, bug({ status: "closed", substatus: "closed" }), report(), 409, "already_resolved"],
    ["a different PR than the linked one", PR, bug({ pullRequestUrl: "https://github.com/acme/app/pull/99" }), report(), 409, "pr_mismatch"],
    ["a linked PR in another repo", "https://github.com/other/app/pull/12", bug({ pullRequestUrl: "https://github.com/other/app/pull/12" }), report({ pullRequestUrl: "https://github.com/other/app/pull/12" }), 409, "pr_broken"],
    ["a PR nobody has reported", PR, bug(), null, 409, "needs_pr_report"],
    ["a merge not yet in the default branch", PR, bug(), report({ mergedInto: "staging", inDefaultBranch: false }), 409, "awaiting_release"],
    ["a PR reported closed without merging", PR, bug(), report({ state: "closed", ...unmerged }), 409, "pr_broken"],
    ["a PR reported missing", PR, bug(), report({ state: "not_found", ...unmerged }), 409, "pr_broken"],
    ["a PR reported open", PR, bug(), report({ state: "open", ...unmerged }), 409, "not_merged"],
  ])("refuses %s and changes nothing", async (_name, url, found, latest, status, error) => {
    db.bug.findFirst.mockResolvedValue(found);
    db.pullRequestReport.findFirst.mockResolvedValue(latest);
    const result = await resolveMergedFix(agent(), scope, "bug1", url as string);
    expect(result).toMatchObject({ status, body: { error } });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("records and publishes nothing when the status changed after it was read", async () => {
    db.bug.findFirst.mockResolvedValue(bug({ claims: [{ id: "c1", agentId: "a9", beneficiaryUserId: "owner" }] }));
    db.tx.bug.updateMany.mockResolvedValue({ count: 0 });
    expect(await resolveMergedFix(agent(), scope, "bug1", PR)).toMatchObject({ status: 409, body: { error: "status_changed" } });
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
