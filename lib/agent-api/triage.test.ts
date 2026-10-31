import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  bug: { findMany: vi.fn() },
  testVerdict: { findMany: vi.fn() },
  delivery: { findMany: vi.fn() },
  issueBid: { findMany: vi.fn() },
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
import { GitHubError, type GitHubClient, type PullRequest } from "@/lib/github/merge-pr";
import {
  clearTriageCache,
  linkStateFromUrl,
  mapLimit,
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

const agent = (ownerId = "dana", level: AgentContext["level"] = "manager"): AgentContext =>
  ({ agentId: `agent-${ownerId}`, name: ownerId, ownerId, tenantId: "t1", level, burst: false, keyId: "k" });

const merged: PullRequest = {
  merged: true, mergeable: true, headSha: "head-sha", state: "closed",
  baseRef: "main", baseRepo: "emerjent/ziki", defaultBranch: "main", mergeCommitSha: "merge-sha",
};
const open: PullRequest = { merged: false, mergeable: true, headSha: "head-sha", state: "open", baseRef: "main", defaultBranch: "main", mergeCommitSha: null };

/** A fake GitHub: `prs` by number in emerjent/ziki (missing → 404), and the compare status. */
function github(prs: Record<number, PullRequest>, compare?: string) {
  const getPullRequest = vi.fn(async (ref: { owner: string; repo: string; number: number }) => {
    const pr = prs[ref.number];
    if (!pr) throw new GitHubError("Not Found", 404);
    return pr;
  });
  const compareCommits = vi.fn(async () => ({ status: compare ?? "ahead" }));
  return { client: { getPullRequest, compareCommits } as unknown as GitHubClient, getPullRequest, compareCommits };
}

/** An issue filed by Ada, claimed by Cara's agent. */
function bug(over: Record<string, unknown> = {}) {
  return {
    id: "bug1", tenantId: "t1", projectId: "p1", status: "done", number: 552, title: "Fix the redirect",
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

const pr = (over: Partial<TriagePullRequest> = {}): TriagePullRequest => ({
  url: PR, linkState: "ok", state: "open", mergedInto: null, defaultBranch: "main", inDefaultBranch: null,
  headSha: "head-sha", mergeCommitSha: null, sameNumberInProjectRepo: null, ...over,
});

function facts(over: Partial<TriageFacts> = {}): TriageFacts {
  return {
    bug: bug() as unknown as TriageFacts["bug"],
    projectId: "p1",
    repo: REPO,
    thresholdOnly: false,
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
  clearTriageCache();
  workflow.workflowFor.mockResolvedValue({ verdictsNeeded: 2, offerWindowSeconds: 1800, governance: "manager" });
  holders.currentHold.mockResolvedValue(null);
  stranded.strandedDelivery.mockResolvedValue(null);
  idle.idleInProgress.mockResolvedValue(null);
  stale.staleHold.mockResolvedValue(null);
  db.project.findFirst.mockResolvedValue({ id: "p1", slug: "ziki", repoUrl: "https://github.com/emerjent/ziki.git", githubInstallationId: "inst" });
  db.bug.findMany.mockResolvedValue([]);
  db.testVerdict.findMany.mockResolvedValue([]);
  db.delivery.findMany.mockResolvedValue([]);
  db.issueBid.findMany.mockResolvedValue([]);
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
  it("reads a PR merged into the default branch", async () => {
    const gh = github({ 552: merged });
    expect(await pullRequestFacts(PR, REPO, gh.client)).toEqual({
      url: PR, linkState: "ok", state: "merged", mergedInto: "main", defaultBranch: "main", inDefaultBranch: true,
      headSha: "head-sha", mergeCommitSha: "merge-sha", sameNumberInProjectRepo: null,
    });
    expect(gh.compareCommits).not.toHaveBeenCalled();
  });

  it.each([["behind", true], ["identical", true], ["ahead", false], ["diverged", false]])(
    "asks whether main contains a PR merged into staging (compare %s)",
    async (status, contained) => {
      const gh = github({ 552: { ...merged, baseRef: "staging" } }, status);
      const facts = await pullRequestFacts(PR, REPO, gh.client);
      expect(facts).toMatchObject({ state: "merged", mergedInto: "staging", inDefaultBranch: contained });
      expect(gh.compareCommits).toHaveBeenCalledWith(REPO, "main", "merge-sha");
    },
  );

  it("marks a link in the project's repository that GitHub answers 404 as not_found", async () => {
    expect(await pullRequestFacts(PR, REPO, github({}).client)).toMatchObject({ linkState: "not_found", state: "unknown" });
  });

  it("reads a link under an old repository name as the same number in the project's repository", async () => {
    const gh = github({ 552: open });
    expect(await pullRequestFacts(OLD, REPO, gh.client)).toMatchObject({ linkState: "old_repository", state: "open", sameNumberInProjectRepo: true });
    expect(gh.getPullRequest).toHaveBeenCalledWith({ ...REPO, number: 552 });
    expect(await pullRequestFacts("https://github.com/zeduchat/bug-tracker/pull/9", REPO, gh.client)).toMatchObject({
      linkState: "old_repository", sameNumberInProjectRepo: false,
    });
  });

  it("only says whether the number exists here for a link in another repository", async () => {
    const facts = await pullRequestFacts("https://github.com/someone/fork/pull/552", REPO, github({ 552: merged }).client);
    expect(facts).toMatchObject({ linkState: "other_repository", state: "unknown", sameNumberInProjectRepo: true });
  });

  it("without GitHub, takes linkState from the URL and leaves the state unknown", async () => {
    expect(await pullRequestFacts(OLD, REPO, null)).toMatchObject({ linkState: "old_repository", state: "unknown", inDefaultBranch: null });
    expect(await pullRequestFacts(PR, REPO, null)).toMatchObject({ linkState: "ok", state: "unknown" });
  });

  it("leaves the state unknown when GitHub doesn't answer, and doesn't cache that", async () => {
    const getPullRequest = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(open);
    const client = { getPullRequest } as unknown as GitHubClient;
    expect(await pullRequestFacts(PR, REPO, client)).toMatchObject({ linkState: "ok", state: "unknown" });
    expect(await pullRequestFacts(PR, REPO, client)).toMatchObject({ state: "open" });
  });

  it("keeps each pull request's answer for five minutes", async () => {
    const gh = github({ 552: open });
    await pullRequestFacts(PR, REPO, gh.client, 1_000);
    await pullRequestFacts(PR, REPO, gh.client, 1_000 + 4 * 60_000);
    expect(gh.getPullRequest).toHaveBeenCalledTimes(1);
    await pullRequestFacts(PR, REPO, gh.client, 1_000 + 6 * 60_000);
    expect(gh.getPullRequest).toHaveBeenCalledTimes(2);
  });
});

describe("mapLimit", () => {
  it("runs at most the limit at once and keeps the order", async () => {
    let running = 0;
    let most = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 4, async (n) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(most).toBeLessThanOrEqual(4);
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

  it("notes judgements that are not on the current head", () => {
    const [accept] = nextActions(manager, facts({ judgements: { good: 2, notGood: 0, needed: 2, goodAtHead: 1, headSha: "abcdef123" } }));
    expect(accept).toMatchObject({ canAct: true });
    expect(accept.note).toContain("Only 1 of 2 judgements are on the current head (abcdef1)");
  });

  it("offers resolve for In progress work whose PR is already merged into main (production #682)", () => {
    const actions = nextActions(manager, facts({
      bug: bug({ status: "in_progress" }) as unknown as TriageFacts["bug"],
      pullRequest: pr({ state: "merged", mergedInto: "main", inDefaultBranch: true, mergeCommitSha: "merge-sha" }),
    }));
    expect(actions).toEqual([{ action: "resolve", method: "POST", route: "/api/v1/issues/bug1/resolve?projectId=p1", minimumRole: "manager", canAct: true }]);
  });

  it("says a PR merged into staging and not released yet is awaiting release", () => {
    const actions = nextActions(manager, facts({ pullRequest: pr({ state: "merged", mergedInto: "staging", inDefaultBranch: false }) }));
    expect(actions).toEqual([expect.objectContaining({
      action: "awaiting_release", canAct: false, blockedReason: "Merged into staging; reconcile once staging is released to main.",
    })]);
  });

  it("offers repair for a link under an old name whose number exists here, and blocks the accept until then", () => {
    const actions = nextActions(manager, facts({ pullRequest: pr({ url: OLD, linkState: "old_repository", sameNumberInProjectRepo: true }) }));
    expect(names(actions)).toEqual(["repair_pull_request", "accept_fix"]);
    expect(actions[0]).toMatchObject({ canAct: true, route: "/api/v1/issues/bug1/pull-request?projectId=p1" });
    expect(actions[1]).toMatchObject({ canAct: false, blockedReason: "The PR link uses an old repository name: repair it first." });
  });

  it("tells the manager the author must submit a new PR when there is nothing to repair to", () => {
    const missing = nextActions(manager, facts({ pullRequest: pr({ url: OLD, linkState: "old_repository", sameNumberInProjectRepo: false }) }));
    expect(missing[0]).toMatchObject({ action: "repair_pull_request", canAct: false });
    expect(missing[0].blockedReason).toContain("the author must submit a new PR");
    const gone = nextActions(manager, facts({ pullRequest: pr({ linkState: "not_found", state: "unknown" }) }));
    expect(gone[0].blockedReason).toContain("The PR returns 404");
    expect(gone[1]).toMatchObject({ action: "accept_fix", canAct: false, blockedReason: "The PR returns 404." });
  });

  it("asks a Delivered fix to be judged, unless the caller's owner judged it already", () => {
    const delivered = { bug: bug({ status: "delivered" }) as unknown as TriageFacts["bug"] };
    expect(nextActions(manager, facts(delivered))[0]).toMatchObject({ action: "submit_test_result", minimumRole: "working", canAct: true });
    expect(nextActions(manager, facts({ ...delivered, judgedByCaller: true }))[0]).toMatchObject({
      canAct: false, blockedReason: "Your owner already judged this pull request.",
    });
  });

  it("asks for the merger on Ready to Merge work", () => {
    const ready = facts({ bug: bug({ status: "ready_to_merge" }) as unknown as TriageFacts["bug"] });
    expect(nextActions(manager, ready)[0]).toMatchObject({ action: "merge_fix", canAct: false, blockedReason: "Needs a merger agent." });
    expect(nextActions({ ...manager, level: "merger" }, ready)[0]).toMatchObject({ action: "merge_fix", canAct: true });
  });

  it("offers deliver_stranded, not also review_idle, on a stranded In progress issue", () => {
    const actions = nextActions(manager, facts({
      bug: bug({ status: "in_progress", claims: [] }) as unknown as TriageFacts["bug"],
      stranded: { pullRequestUrl: PR, creditedUserId: "cara", linkedAt: new Date(), goodVerdicts: 2, needed: 2 },
      idle: { held: false, holderOwners: [], idleHours: 5 },
    }));
    expect(names(actions)).toEqual(["deliver_stranded"]);
    expect(actions[0]).toMatchObject({ canAct: true, route: "/api/v1/issues/bug1/delivery?projectId=p1" });
  });

  it("offers review_idle for idle work nobody holds, and an Abandoned vote for held work", () => {
    const unheld = nextActions(manager, facts({
      bug: bug({ status: "in_progress", claims: [], assigneeId: null }) as unknown as TriageFacts["bug"],
      idle: { held: false, holderOwners: [], idleHours: 3 },
    }));
    expect(unheld[0]).toMatchObject({ action: "review_idle", route: "/api/v1/issues/bug1/reclaim?projectId=p1", canAct: true });
    const held = nextActions(manager, facts({
      bug: bug({ status: "in_progress" }) as unknown as TriageFacts["bug"],
      idle: { held: true, holderOwners: ["cara"], idleHours: 3 },
    }));
    expect(held[0]).toMatchObject({ action: "vote_abandoned", canAct: true });
  });

  it("awards the most voted bid from another owner on an Open issue nobody holds", () => {
    const openIssue = { bug: bug({ status: "open", claims: [], assigneeId: null, pullRequestUrl: null }) as unknown as TriageFacts["bug"], pullRequest: pr({ url: null, linkState: "missing", state: "unknown" }), judgements: null };
    const bids = [{ id: "bid-dana", votes: 5, ownerIds: ["dana"] }, { id: "bid-erin", votes: 2, ownerIds: ["erin"] }];
    expect(nextActions(manager, facts({ ...openIssue, bids }))).toEqual([expect.objectContaining({
      action: "award_bid", route: "/api/v1/bids/bid-erin/award?projectId=p1", canAct: true,
    })]);
    expect(nextActions(manager, facts({ ...openIssue, bids: [bids[0]] }))[0]).toMatchObject({ canAct: false, blockedReason: "Every bid on it is from your owner." });
    const hold = { id: "c", agentName: "Erin's agent", personName: "Erin", via: "bid" as const, dispatcherName: null, status: "offered" as const, offeredAt: new Date(), claimedAt: null, deliverBy: null };
    expect(nextActions(manager, facts({ ...openIssue, bids, hold }))[0]).toMatchObject({ canAct: false, blockedReason: "Erin's agent for Erin has a live offer on it." });
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

  it("returns one item per issue with its holder, PR, judgements and next actions", async () => {
    db.bug.findMany.mockResolvedValue([
      bug({ id: "bug1", status: "in_progress" }),
      bug({ id: "bug2", number: 553, status: "done", pullRequestUrl: "https://github.com/Zedu-Endor/issue-tracker/pull/553" }),
    ]);
    holders.currentHold.mockImplementation(async (id: string) => (id === "bug1"
      ? { id: "claim1", agentName: "Cara's agent", personName: "Cara", via: "bid", dispatcherName: null, status: "active", offeredAt: null, claimedAt: new Date("2026-10-20T11:00:00Z"), deliverBy: null }
      : null));
    db.testVerdict.findMany.mockResolvedValue([
      { goodToMerge: true, headSha: "head-sha", onBehalfOfUserId: "erin", agent: { id: "agent-erin", ownerUserId: "erin" } },
      { goodToMerge: true, headSha: "old-sha", onBehalfOfUserId: "finn", agent: { id: "agent-finn", ownerUserId: "finn" } },
    ]);
    const gh = github({ 552: merged, 553: open });

    const page = await triageQueue(agent(), scope, { limit: 50, cursor: null }, { clientFor: () => gh.client });

    expect(page).toMatchObject({ nextCursor: null, githubAvailable: true });
    expect(page.items).toHaveLength(2);
    const [first, second] = page.items;
    expect(first.issue).toMatchObject({ id: "bug1", number: 552, status: "in_progress" });
    expect(first.issue.url).toMatch(/\/ziki\/552$/);
    expect(first.holder).toMatchObject({ state: "active_claim", agentName: "Cara's agent", personName: "Cara", via: "bid", staleAssignee: false });
    expect(first.pullRequest).toMatchObject({ linkState: "ok", state: "merged", mergedInto: "main", inDefaultBranch: true });
    expect(first.judgements).toEqual({ good: 2, notGood: 0, needed: 2, goodAtHead: 1, headSha: "head-sha" });
    expect(first.nextActions.map((a) => [a.action, a.canAct])).toEqual([["resolve", true]]);

    expect(second.pullRequest).toMatchObject({ linkState: "old_repository", state: "open", sameNumberInProjectRepo: true });
    expect(second.holder).toMatchObject({ state: "none", assignee: { id: "cara", name: "Cara" }, staleAssignee: false });
    expect(second.nextActions.map((a) => a.action)).toEqual(["repair_pull_request", "accept_fix"]);
    expect(db.bug.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 51 }));
  });

  it("without GitHub, takes linkState from the URL and leaves the state unknown", async () => {
    db.bug.findMany.mockResolvedValue([bug({ pullRequestUrl: OLD })]);
    const page = await triageQueue(agent(), scope, { limit: 50, cursor: null }, { clientFor: () => null });
    expect(page.githubAvailable).toBe(false);
    expect(page.items[0].pullRequest).toMatchObject({ linkState: "old_repository", state: "unknown" });
  });

  it("flags an Open issue's stale assignee and counts its open bids", async () => {
    db.bug.findMany.mockResolvedValue([bug({ status: "open", claims: [], pullRequestUrl: null })]);
    db.issueBid.findMany.mockResolvedValue([
      { id: "bid1", beneficiaryUserId: "erin", agent: { ownerUserId: "erin" }, _count: { votes: 1 } },
      { id: "bid2", beneficiaryUserId: "finn", agent: { ownerUserId: "finn" }, _count: { votes: 3 } },
    ]);
    const page = await triageQueue(agent(), scope, { limit: 50, cursor: null }, { clientFor: () => null });
    const [item] = page.items;
    expect(item.holder).toMatchObject({ state: "none", staleAssignee: true });
    expect(item.bids).toEqual({ open: 2 });
    expect(item.judgements).toBeNull();
    expect(item.nextActions[0]).toMatchObject({ action: "award_bid", route: "/api/v1/bids/bid2/award?projectId=p1", canAct: true });
  });

  it("pages with a cursor when there are more issues than the limit", async () => {
    db.bug.findMany.mockResolvedValue([bug({ id: "a" }), bug({ id: "b" })]);
    const page = await triageQueue(agent(), scope, { limit: 1, cursor: null }, { clientFor: () => null });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
  });
});
