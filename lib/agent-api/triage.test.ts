import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  bug: { findMany: vi.fn() },
  testVerdict: { findMany: vi.fn() },
  delivery: { findMany: vi.fn() },
  issueBid: { findMany: vi.fn() },
  pullRequestReport: { findMany: vi.fn() },
}));
const holders = vi.hoisted(() => ({ currentHold: vi.fn() }));
const stranded = vi.hoisted(() => ({ strandedDelivery: vi.fn() }));
const idle = vi.hoisted(() => ({ idleInProgress: vi.fn() }));
const stale = vi.hoisted(() => ({ staleHold: vi.fn() }));
const workflow = vi.hoisted(() => ({ workflowFor: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/issue-holders", () => holders);
vi.mock("@/lib/agent-api/stranded-delivery", () => stranded);
vi.mock("@/lib/agent-api/idle", () => idle);
vi.mock("@/lib/agent-api/stale-hold", () => stale);
vi.mock("@/lib/workflow", () => workflow);

import type { AgentContext } from "@/lib/agents/require-agent";
import { AgentLevelError } from "@/lib/agents/levels";
import { linkStateFromUrl } from "./pr-gate";
import type { StoredPullRequestReport } from "./pull-request-report";
import {
  nextActions,
  parseTriageQuery,
  pullRequestFacts,
  triageQueue,
  type TriageFacts,
  type TriagePullRequest,
} from "./triage";

const REPO = { owner: "emerjent", repo: "ziki" };
const PR = "https://github.com/emerjent/ziki/pull/552";
const OLD = "https://github.com/Zedu-Endor/issue-tracker/pull/552";
const scope = { tenantId: "t1", projectId: "p1" };
const NOW = Date.parse("2026-10-31T12:00:00Z");

const agent = (ownerId = "dana", level: AgentContext["level"] = "manager"): AgentContext =>
  ({ agentId: `agent-${ownerId}`, name: ownerId, ownerId, tenantId: "t1", level, burst: false, keyId: "k" });

/** Erin's agent's report, a minute old: open, checks passing, can merge, at Ziki's head. */
function report(over: Partial<StoredPullRequestReport> = {}): StoredPullRequestReport {
  return {
    id: "rep1", bugId: "bug1", pullRequestUrl: PR, state: "open", mergedInto: null, inDefaultBranch: null,
    headSha: "head-sha", mergeCommitSha: null, checks: "passing", mergeable: true, note: "Checked on GitHub.",
    agentId: "agent-erin", onBehalfOfUserId: "erin", createdAt: new Date(NOW - 60_000),
    agent: { name: "Erin's agent" }, onBehalfOf: { name: "Erin" },
    ...over,
  } as StoredPullRequestReport;
}

/** An issue filed by Ada, claimed by Cara's agent. */
function bug(over: Record<string, unknown> = {}) {
  return {
    id: "bug1", tenantId: "t1", projectId: "p1", status: "done", substatus: "accepted", number: 552, title: "Fix the redirect",
    createdAt: new Date("2026-10-20T10:00:00Z"),
    pullRequestUrl: PR, pullRequestHeadSha: "head-sha",
    assigneeId: "cara", assignee: { id: "cara", name: "Cara" },
    beneficiaryUserId: "ada", reporterId: "ada", createdByAgentId: null, createdByAgent: null,
    claims: [{
      id: "claim1", status: "active", claimedAt: new Date("2026-10-20T11:00:00Z"), releasedAt: null, agentId: "agent-cara",
      beneficiaryUserId: "cara", dispatcherUserId: null, agent: { ownerUserId: "cara" },
    }],
    ...over,
  };
}

/** The pull request as triage reads it, through the real gate. */
const pr = (rep: StoredPullRequestReport | null = report(), url: string | null = PR, head: string | null = "head-sha"): TriagePullRequest =>
  pullRequestFacts(url, REPO, rep, head, NOW);

function facts(over: Partial<TriageFacts> = {}): TriageFacts {
  return {
    bug: bug() as unknown as TriageFacts["bug"],
    projectId: "p1",
    repo: REPO,
    thresholdOnly: false,
    awardThreshold: 3,
    pullRequest: pr(),
    judgements: { good: 2, notGood: 0, needed: 2, goodAtHead: 2, headSha: "head-sha" },
    bids: [],
    hold: null,
    stranded: null,
    idle: null,
    stale: null,
    judgedByCaller: false,
    ...over,
  };
}

const manager = { agentId: "agent-dana", ownerId: "dana", level: "manager" as const };

beforeEach(() => {
  vi.clearAllMocks();
  workflow.workflowFor.mockResolvedValue({ verdictsNeeded: 2, offerWindowSeconds: 1800, governance: "manager", awardThreshold: 3, managerVoteWeight: 3 });
  holders.currentHold.mockResolvedValue(null);
  stranded.strandedDelivery.mockResolvedValue(null);
  idle.idleInProgress.mockResolvedValue(null);
  stale.staleHold.mockResolvedValue(null);
  db.project.findFirst.mockResolvedValue({ id: "p1", slug: "ziki", repoUrl: "https://github.com/emerjent/ziki.git" });
  db.bug.findMany.mockResolvedValue([]);
  db.testVerdict.findMany.mockResolvedValue([]);
  db.delivery.findMany.mockResolvedValue([]);
  db.issueBid.findMany.mockResolvedValue([]);
  db.pullRequestReport.findMany.mockResolvedValue([]);
});

describe("linkStateFromUrl", () => {
  it.each([
    [PR, "ok"],
    ["https://github.com/Emerjent/Ziki/pull/552", "ok"],
    [OLD, "old_repository"],
    ["https://github.com/zeduchat/bug-tracker/pull/9", "old_repository"],
    ["https://github.com/emerjent/bug-tracker/pull/9", "old_repository"],
    ["https://github.com/someone/fork/pull/3", "other_repository"],
    ["https://gitlab.com/emerjent/ziki/-/merge_requests/1", "other_repository"],
    [null, "missing"],
    ["", "missing"],
  ])("%s is %s", (url, state) => {
    expect(linkStateFromUrl(url, REPO)).toBe(state);
  });

  it("is unknown when the project names no repository", () => {
    expect(linkStateFromUrl(PR, null)).toBe("unknown");
  });
});

describe("pullRequestFacts", () => {
  it("reads a PR reported merged into the default branch, with who reported it and when", () => {
    const facts = pr(report({ state: "merged", mergedInto: "main", inDefaultBranch: true, mergeCommitSha: "merge-sha" }));
    expect(facts).toMatchObject({
      url: PR, linkState: "ok", state: "merged", mergedInto: "main", inDefaultBranch: true,
      headSha: "head-sha", mergeCommitSha: "merge-sha", reportWanted: null,
    });
    expect(facts.gate).toMatchObject({ canReconcile: true, awaitingRelease: false, broken: null });
    expect(facts.report).toMatchObject({ id: "rep1", state: "merged", ageMinutes: 1, reportedBy: { agentId: "agent-erin", agentName: "Erin's agent", userId: "erin", name: "Erin" } });
  });

  it("says a PR reported merged into staging is awaiting release", () => {
    const facts = pr(report({ state: "merged", mergedInto: "staging", inDefaultBranch: false }));
    expect(facts).toMatchObject({ state: "merged", mergedInto: "staging", inDefaultBranch: false, reportWanted: null });
    expect(facts.gate).toMatchObject({ canReconcile: false, awaitingRelease: true });
    expect(facts.gate.reason).toContain('Merged into "staging"');
  });

  it("is unreported with no report, keeps Ziki's head, and wants a report", () => {
    const facts = pr(null, PR, "ziki-head");
    expect(facts).toMatchObject({
      linkState: "ok", state: "unreported", mergedInto: null, inDefaultBranch: null, headSha: "ziki-head",
      checks: null, mergeable: null, report: null, reportWanted: "Nobody has reported this pull request's state yet.",
    });
    expect(facts.gate).toMatchObject({ canDeliver: true, canAccept: false, needsReport: true });
  });

  it("ignores a report on another pull request address", () => {
    const facts = pr(report({ pullRequestUrl: "https://github.com/emerjent/ziki/pull/551", state: "merged", inDefaultBranch: true }));
    expect(facts).toMatchObject({ state: "unreported", report: null });
    expect(facts.gate.canReconcile).toBe(false);
  });

  it("wants a new report once the latest is old, or the head moved since it", () => {
    expect(pr(report({ createdAt: new Date(NOW - 7 * 3_600_000) })).reportWanted).toBe("The latest report is 7 hours old.");
    const moved = pr(report({ headSha: "old-sha" }));
    expect(moved.headSha).toBe("old-sha");
    expect(moved.gate.canAccept).toBe(false);
    expect(moved.reportWanted).toContain("The head moved since the last report");
  });

  it("takes linkState from the URL and wants no report on a link outside the project's repository", () => {
    const old = pr(null, OLD);
    expect(old).toMatchObject({ linkState: "old_repository", state: "unreported", reportWanted: null });
    expect(old.gate.broken).toBe("old_repository");
    expect(pr(null, "https://github.com/someone/fork/pull/552").gate.broken).toBe("other_repository");
  });

  it("reads a report of a 404 as broken", () => {
    const gone = pr(report({ state: "not_found", headSha: null, checks: null, mergeable: null }));
    expect(gone).toMatchObject({ linkState: "ok", state: "not_found", reportWanted: null });
    expect(gone.gate).toMatchObject({ broken: "not_found", canDeliver: false, canAccept: false });
  });
});

describe("nextActions", () => {
  const names = (actions: ReturnType<typeof nextActions>) => actions.map((a) => a.action);

  it("lets an independent manager accept a Done fix with enough judgements", () => {
    const [accept] = nextActions(manager, facts());
    expect(accept).toEqual({ action: "accept_fix", method: "POST", route: "/api/v1/issues/bug1/merge?projectId=p1", minimumRole: "manager", canAct: true });
  });

  it("says why an accept is blocked: short of judgements, or not independent", () => {
    const short = nextActions(manager, facts({ judgements: { good: 2, notGood: 0, needed: 3, goodAtHead: 2, headSha: "head-sha" } }));
    expect(short[0]).toMatchObject({ action: "accept_fix", canAct: false, blockedReason: "2 of 3 good-to-merge judgements on the linked pull request." });
    const own = nextActions({ ...manager, agentId: "agent-cara", ownerId: "cara" }, facts());
    expect(own[0]).toMatchObject({ canAct: false });
    expect(own[0].blockedReason).toMatch(/^Not independent: /);
    const working = nextActions({ ...manager, level: "working" }, facts());
    expect(working[0]).toMatchObject({ canAct: false, blockedReason: "Needs a manager agent." });
  });

  it("blocks the accept by the latest report: failing checks, or a conflict", () => {
    const failing = nextActions(manager, facts({ pullRequest: pr(report({ checks: "failing" })) }));
    expect(failing).toEqual([expect.objectContaining({ action: "accept_fix", canAct: false, blockedReason: "The latest report says its checks are failing: the author fixes them and pushes." })]);
    const conflict = nextActions(manager, facts({ pullRequest: pr(report({ mergeable: false })) }));
    expect(conflict[0]).toMatchObject({ action: "accept_fix", canAct: false });
    expect(conflict[0].blockedReason).toContain("The latest report says it can't merge");
  });

  it("asks an independent agent to report an unreported PR, and blocks the accept until then", () => {
    const unreported = facts({ pullRequest: pr(null) });
    const actions = nextActions(manager, unreported);
    expect(names(actions)).toEqual(["report_pr_status", "accept_fix"]);
    expect(actions[0]).toEqual({
      action: "report_pr_status", method: "POST", route: "/api/v1/issues/bug1/pull-request-status?projectId=p1",
      minimumRole: "working", canAct: true, note: "Nobody has reported this pull request's state yet.",
    });
    expect(actions[1]).toMatchObject({ action: "accept_fix", canAct: false });
    expect(actions[1].blockedReason).toMatch(/^No agent has reported this pull request's state yet\./);

    // A working agent may report; the holder's owner may not.
    expect(nextActions({ agentId: "agent-eli", ownerId: "eli", level: "working" }, unreported)[0]).toMatchObject({ action: "report_pr_status", canAct: true });
    const holder = nextActions({ ...manager, agentId: "agent-cara", ownerId: "cara" }, unreported)[0];
    expect(holder).toMatchObject({ action: "report_pr_status", canAct: false });
    expect(holder.blockedReason).toMatch(/^Not independent: /);
  });

  it("asks for a fresh report once the latest one is old, without blocking the accept", () => {
    const actions = nextActions(manager, facts({ pullRequest: pr(report({ createdAt: new Date(NOW - 7 * 3_600_000) })) }));
    expect(names(actions)).toEqual(["report_pr_status", "accept_fix"]);
    expect(actions[0]).toMatchObject({ canAct: true, note: "The latest report is 7 hours old." });
    expect(actions[1]).toMatchObject({ canAct: true });
  });

  it("notes judgements that are not on the current head", () => {
    const [accept] = nextActions(manager, facts({ judgements: { good: 2, notGood: 0, needed: 2, goodAtHead: 1, headSha: "abcdef123" } }));
    expect(accept).toMatchObject({ canAct: true });
    expect(accept.note).toContain("Only 1 of 2 judgements are on the current head (abcdef1)");
  });

  it("offers resolve for In progress work whose PR is reported merged into main (production #682)", () => {
    const actions = nextActions(manager, facts({
      bug: bug({ status: "in_progress", substatus: "in_progress" }) as unknown as TriageFacts["bug"],
      pullRequest: pr(report({ state: "merged", mergedInto: "main", inDefaultBranch: true, mergeCommitSha: "merge-sha" })),
    }));
    expect(actions).toEqual([{ action: "resolve", method: "POST", route: "/api/v1/issues/bug1/resolve?projectId=p1", minimumRole: "manager", canAct: true }]);
  });

  it("says a PR reported merged into staging and not released yet is awaiting release, and offers no accept", () => {
    const actions = nextActions(manager, facts({ pullRequest: pr(report({ state: "merged", mergedInto: "staging", inDefaultBranch: false })) }));
    expect(actions).toEqual([expect.objectContaining({
      action: "awaiting_release", route: "/api/v1/issues/bug1/resolve?projectId=p1", canAct: false,
    })]);
    expect(actions[0].blockedReason).toContain('Merged into "staging", which isn\'t released to the default branch yet');
  });

  it("asks for a report when a merged PR's report doesn't say whether the default branch contains it", () => {
    const actions = nextActions(manager, facts({ pullRequest: pr(report({ state: "merged", mergedInto: "main", inDefaultBranch: null })) }));
    expect(names(actions)).toEqual(["report_pr_status", "resolve"]);
    expect(actions[1]).toMatchObject({ canAct: false });
    expect(actions[1].blockedReason).toContain("not whether the default branch contains it");
  });

  it("offers repair for a link under an old name, and blocks the accept until then", () => {
    const actions = nextActions(manager, facts({ pullRequest: pr(null, OLD) }));
    expect(names(actions)).toEqual(["repair_pull_request", "accept_fix"]);
    expect(actions[0]).toMatchObject({ canAct: true, route: "/api/v1/issues/bug1/pull-request?projectId=p1" });
    expect(actions[0].note).toContain("Leave pullRequestUrl out to link #552 in emerjent/ziki");
    expect(actions[1]).toMatchObject({ canAct: false });
    expect(actions[1].blockedReason).toContain("uses an old name of the project's repository");
  });

  it("offers repair for a link in another repository", () => {
    const actions = nextActions(manager, facts({ pullRequest: pr(null, "https://github.com/someone/fork/pull/3") }));
    expect(names(actions)).toEqual(["repair_pull_request", "accept_fix"]);
    expect(actions[0].note).toContain("The link points outside emerjent/ziki; check that #3 there is the same work");
    expect(actions[1].blockedReason).toContain("not in the project's repository");
  });

  it("tells the manager the author must submit a new PR when the PR is reported 404 or closed", () => {
    const gone = nextActions(manager, facts({ pullRequest: pr(report({ state: "not_found" })) }));
    expect(names(gone)).toEqual(["repair_pull_request", "accept_fix"]);
    expect(gone[0]).toMatchObject({ canAct: true });
    expect(gone[0].note).toContain("Only once the author has opened a new pull request in emerjent/ziki");
    expect(gone[1]).toMatchObject({ canAct: false });
    expect(gone[1].blockedReason).toContain("doesn't exist on GitHub (404)");

    const closed = nextActions(manager, facts({ pullRequest: pr(report({ state: "closed" })) }));
    expect(names(closed)).toEqual(["repair_pull_request", "accept_fix"]);
    expect(closed[1].blockedReason).toContain("closed without being merged");
  });

  it("asks a Delivered fix to be judged, unless the caller's owner judged it already", () => {
    const delivered = { bug: bug({ status: "done", substatus: "requires_review" }) as unknown as TriageFacts["bug"] };
    expect(nextActions(manager, facts(delivered))[0]).toMatchObject({ action: "submit_test_result", minimumRole: "working", canAct: true });
    expect(nextActions(manager, facts({ ...delivered, judgedByCaller: true }))[0]).toMatchObject({
      canAct: false, blockedReason: "Your owner already judged this pull request.",
    });
  });

  it("asks the merger to merge Ready to Merge work on GitHub, then report and resolve it", () => {
    const ready = facts({ bug: bug({ status: "merge", substatus: "ready_to_merge" }) as unknown as TriageFacts["bug"] });
    expect(nextActions(manager, ready)[0]).toMatchObject({ action: "merge_on_github", minimumRole: "merger", canAct: false, blockedReason: "Needs a merger agent." });
    const [merge] = nextActions({ ...manager, level: "merger" }, ready);
    expect(merge).toMatchObject({ action: "merge_on_github", route: "/api/v1/issues/bug1/pull-request-status?projectId=p1", canAct: true });
    expect(merge.note).toContain(`Merge ${PR} on GitHub yourself`);
    expect(merge.note).toContain("POST /api/v1/issues/bug1/resolve?projectId=p1");

    // Not merged without a report that lets it.
    const unreported = nextActions({ ...manager, level: "merger" }, { ...ready, pullRequest: pr(null) });
    expect(names(unreported)).toEqual(["report_pr_status", "merge_on_github"]);
    expect(unreported[1]).toMatchObject({ canAct: false });
    expect(unreported[1].blockedReason).toMatch(/^No agent has reported/);
  });

  it("offers deliver_stranded, not also review_idle, on a stranded In progress issue", () => {
    const actions = nextActions(manager, facts({
      bug: bug({ status: "in_progress", substatus: "in_progress", claims: [] }) as unknown as TriageFacts["bug"],
      stranded: { pullRequestUrl: PR, creditedUserId: "cara", linkedAt: new Date(), goodVerdicts: 2, needed: 2 },
      idle: { held: false, holderOwners: [], idleHours: 5 },
    }));
    expect(names(actions)).toEqual(["deliver_stranded"]);
    expect(actions[0]).toMatchObject({ canAct: true, route: "/api/v1/issues/bug1/delivery?projectId=p1" });
  });

  it("blocks deliver_stranded on a PR reported 404 and offers review_idle instead", () => {
    const actions = nextActions(manager, facts({
      bug: bug({ status: "in_progress", substatus: "in_progress", claims: [] }) as unknown as TriageFacts["bug"],
      pullRequest: pr(report({ state: "not_found" })),
      stranded: { pullRequestUrl: PR, creditedUserId: "cara", linkedAt: new Date(), goodVerdicts: 2, needed: 2 },
      idle: { held: false, holderOwners: [], idleHours: 5 },
    }));
    expect(names(actions)).toEqual(["repair_pull_request", "deliver_stranded", "review_idle"]);
    expect(actions[1]).toMatchObject({ canAct: false });
    expect(actions[1].blockedReason).toContain("doesn't exist on GitHub (404)");
    expect(actions[1].blockedReason).toContain("Nothing to deliver; reclaim it if it is idle.");
    expect(actions[2]).toMatchObject({ canAct: true, route: "/api/v1/issues/bug1/reclaim?projectId=p1" });
  });

  it("offers review_idle for idle work nobody holds, and an Abandoned vote for held work", () => {
    const unheld = nextActions(manager, facts({
      bug: bug({ status: "in_progress", substatus: "in_progress", claims: [], assigneeId: null }) as unknown as TriageFacts["bug"],
      idle: { held: false, holderOwners: [], idleHours: 3 },
    }));
    expect(unheld[0]).toMatchObject({ action: "review_idle", route: "/api/v1/issues/bug1/reclaim?projectId=p1", canAct: true });
    const held = nextActions(manager, facts({
      bug: bug({ status: "in_progress", substatus: "in_progress" }) as unknown as TriageFacts["bug"],
      idle: { held: true, holderOwners: ["cara"], idleHours: 3 },
    }));
    expect(held[0]).toMatchObject({ action: "vote_abandoned", canAct: true });
  });

  it("lets any agent award the most voted bid once it reached the threshold, its own owner's too", () => {
    const openIssue = { bug: bug({ status: "open", substatus: "open", claims: [], assigneeId: null, pullRequestUrl: null }) as unknown as TriageFacts["bug"], pullRequest: pr(null, null, null), judgements: null };
    const bids = [{ id: "bid-dana", votes: 5, ownerIds: ["dana"] }, { id: "bid-erin", votes: 2, ownerIds: ["erin"] }];
    expect(nextActions(manager, facts({ ...openIssue, bids }))).toEqual([expect.objectContaining({
      action: "award_bid", route: "/api/v1/bids/bid-dana/award?projectId=p1", minimumRole: "working", canAct: true,
    })]);
    const working = { agentId: "agent-finn", ownerId: "finn", level: "working" as const };
    expect(nextActions(working, facts({ ...openIssue, bids }))[0]).toMatchObject({ action: "award_bid", canAct: true });
    const hold = { id: "c", agentName: "Erin's agent", personName: "Erin", via: "bid" as const, dispatcherName: null, status: "offered" as const, offeredAt: new Date(), claimedAt: null, deliverBy: null };
    expect(nextActions(manager, facts({ ...openIssue, bids, hold }))[0]).toMatchObject({ canAct: false, blockedReason: "Erin's agent for Erin has a live offer on it." });
  });

  it("asks for a vote, not an award, while every bid is below the threshold", () => {
    const openIssue = { bug: bug({ status: "open", substatus: "open", claims: [], assigneeId: null, pullRequestUrl: null }) as unknown as TriageFacts["bug"], pullRequest: pr(null, null, null), judgements: null };
    const bids = [{ id: "bid-dana", votes: 2, ownerIds: ["dana"] }, { id: "bid-erin", votes: 1, ownerIds: ["erin"] }];
    // A manager may vote for its own owner's bid.
    expect(nextActions(manager, facts({ ...openIssue, bids }))).toEqual([expect.objectContaining({
      action: "vote_bid", route: "/api/v1/bids/bid-dana/votes?projectId=p1", canAct: true,
    })]);
    // A working agent votes for another owner's bid, and has none to vote for when every bid is its owner's.
    const working = { agentId: "agent-dana-2", ownerId: "dana", level: "working" as const };
    expect(nextActions(working, facts({ ...openIssue, bids }))[0]).toMatchObject({ action: "vote_bid", route: "/api/v1/bids/bid-erin/votes?projectId=p1" });
    expect(nextActions(working, facts({ ...openIssue, bids: [bids[0]] }))[0]).toMatchObject({ canAct: false, blockedReason: "Every bid on it is from your owner." });
  });
});

describe("parseTriageQuery", () => {
  it("defaults to 50, caps at 100 and refuses nonsense", () => {
    expect(parseTriageQuery(new URLSearchParams())).toEqual({ limit: 50, cursor: null });
    expect(parseTriageQuery(new URLSearchParams("limit=500")).limit).toBe(100);
    expect(() => parseTriageQuery(new URLSearchParams("limit=0"))).toThrow(/limit must be/);
    expect(() => parseTriageQuery(new URLSearchParams("cursor=nope"))).toThrow("Invalid cursor.");
  });
});

describe("triageQueue", () => {
  it("refuses a working agent", async () => {
    await expect(triageQueue(agent("eli", "working"), scope, { limit: 50, cursor: null })).rejects.toBeInstanceOf(AgentLevelError);
    expect(db.bug.findMany).not.toHaveBeenCalled();
  });

  it("returns one item per issue with its holder, PR from the latest report, judgements and next actions", async () => {
    const old553 = "https://github.com/Zedu-Endor/issue-tracker/pull/553";
    db.bug.findMany.mockResolvedValue([
      bug({ id: "bug1", status: "in_progress", substatus: "in_progress" }),
      bug({ id: "bug2", number: 553, status: "done", substatus: "accepted", pullRequestUrl: old553 }),
    ]);
    db.pullRequestReport.findMany.mockResolvedValue([
      report({ id: "rep2", state: "merged", mergedInto: "main", inDefaultBranch: true, mergeCommitSha: "merge-sha" }),
      report({ id: "rep1", createdAt: new Date(NOW - 3_600_000) }),
    ]);
    holders.currentHold.mockImplementation(async (id: string) => (id === "bug1"
      ? { id: "claim1", agentName: "Cara's agent", personName: "Cara", via: "bid", dispatcherName: null, status: "active", offeredAt: null, claimedAt: new Date("2026-10-20T11:00:00Z"), deliverBy: null }
      : null));
    db.testVerdict.findMany.mockResolvedValue([
      { goodToMerge: true, headSha: "head-sha", onBehalfOfUserId: "erin", agent: { id: "agent-erin", ownerUserId: "erin" } },
      { goodToMerge: true, headSha: "old-sha", onBehalfOfUserId: "finn", agent: { id: "agent-finn", ownerUserId: "finn" } },
    ]);

    const page = await triageQueue(agent(), scope, { limit: 50, cursor: null }, { now: NOW });

    expect(page).toEqual({ items: expect.any(Array), nextCursor: null });
    expect(page.items).toHaveLength(2);
    const [first, second] = page.items;
    expect(first.issue).toMatchObject({ id: "bug1", number: 552, status: "in_progress", substatus: "in_progress" });
    expect(first.issue.url).toMatch(/\/ziki\/552$/);
    expect(first.holder).toMatchObject({ state: "active_claim", agentName: "Cara's agent", personName: "Cara", via: "bid", staleAssignee: false });
    // The latest report counts: the first row per issue.
    expect(first.pullRequest).toMatchObject({ linkState: "ok", state: "merged", mergedInto: "main", inDefaultBranch: true, report: { id: "rep2" } });
    expect(first.judgements).toEqual({ good: 2, notGood: 0, needed: 2, goodAtHead: 1, headSha: "head-sha" });
    expect(first.nextActions.map((a) => [a.action, a.canAct])).toEqual([["resolve", true]]);

    expect(second.pullRequest).toMatchObject({ linkState: "old_repository", state: "unreported", report: null, reportWanted: null });
    expect(second.holder).toMatchObject({ state: "none", assignee: { id: "cara", name: "Cara" }, staleAssignee: false });
    expect(second.nextActions.map((a) => a.action)).toEqual(["repair_pull_request", "accept_fix"]);
    expect(db.bug.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 51 }));
    expect(db.pullRequestReport.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ bugId: "bug1", pullRequestUrl: PR }, { bugId: "bug2", pullRequestUrl: old553 }] },
    }));
  });

  it("asks for a report on a Done fix nobody reported, and blocks its accept", async () => {
    db.bug.findMany.mockResolvedValue([bug({ claims: [] })]);
    const page = await triageQueue(agent(), scope, { limit: 50, cursor: null }, { now: NOW });
    const [item] = page.items;
    expect(item.pullRequest).toMatchObject({ linkState: "ok", state: "unreported", report: null });
    expect(item.nextActions.map((a) => [a.action, a.canAct])).toEqual([["report_pr_status", true], ["accept_fix", false]]);
    expect(item.nextActions[1].blockedReason).toMatch(/^No agent has reported this pull request's state yet\./);
  });

  it("flags an Open issue's stale assignee and counts its open bids", async () => {
    db.bug.findMany.mockResolvedValue([bug({ status: "open", substatus: "open", claims: [], pullRequestUrl: null })]);
    db.issueBid.findMany.mockResolvedValue([
      { id: "bid1", beneficiaryUserId: "erin", agent: { ownerUserId: "erin" }, votes: [{ onBehalfOfUserId: "gus", agent: { level: "working" } }] },
      { id: "bid2", beneficiaryUserId: "finn", agent: { ownerUserId: "finn" }, votes: [{ onBehalfOfUserId: "hana", agent: { level: "manager" } }] },
    ]);
    const page = await triageQueue(agent(), scope, { limit: 50, cursor: null }, { now: NOW });
    const [item] = page.items;
    expect(item.holder).toMatchObject({ state: "none", staleAssignee: true });
    expect(item.bids).toEqual({ open: 2 });
    expect(item.judgements).toBeNull();
    expect(item.nextActions[0]).toMatchObject({ action: "award_bid", route: "/api/v1/bids/bid2/award?projectId=p1", canAct: true });
    // No linked pull request: nothing to ask about it.
    expect(db.pullRequestReport.findMany).not.toHaveBeenCalled();
  });

  it("pages with a cursor when there are more issues than the limit", async () => {
    db.bug.findMany.mockResolvedValue([bug({ id: "a" }), bug({ id: "b" })]);
    const page = await triageQueue(agent(), scope, { limit: 1, cursor: null }, { now: NOW });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
  });
});
