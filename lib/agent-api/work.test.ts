import { describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/agents/require-agent";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { itemsFor, waitingForOthers, workEtag, type AgentWork, type ProjectWork, type WorkFeed } from "./work";
import { prGate } from "./pr-gate";
import type { StoredPullRequestReport } from "./pull-request-report";

const REPO = { owner: "emerjent", repo: "ziki" };
const PR = "https://github.com/emerjent/ziki/pull/552";
const REPORTED_AT = new Date("2026-10-31T11:00:00Z");

/** Erin's agent's report on a pull request: open, checks passing, can merge, at head-sha. */
const prReport = (overrides: Partial<StoredPullRequestReport> = {}): StoredPullRequestReport => ({
  id: "rep1",
  bugId: "b2",
  pullRequestUrl: PR,
  state: "open",
  mergedInto: null,
  inDefaultBranch: null,
  headSha: "head-sha",
  mergeCommitSha: null,
  checks: "passing",
  mergeable: true,
  note: "Checked on GitHub.",
  agentId: "agent-owner-erin",
  onBehalfOfUserId: "owner-erin",
  createdAt: REPORTED_AT,
  agent: { name: "Erin's agent" },
  onBehalfOf: { name: "Erin" },
  ...overrides,
}) as StoredPullRequestReport;

/** An issue In progress or later with its pull request and latest report, through the real gate (#pr-reports). */
const prIssue = (id: string, number: number, pullRequestUrl: string, status: string, report: StoredPullRequestReport | null = null) => ({
  id,
  number,
  title: "Fix",
  status,
  pullRequestUrl,
  report,
  gate: prGate(report, { pullRequestUrl, pullRequestHeadSha: "head-sha", repo: REPO }),
});

const agent = (level: AgentContext["level"], ownerId = "owner-bob"): AgentContext => ({
  agentId: `agent-${ownerId}`,
  name: "bob",
  ownerId,
  tenantId: "t1",
  level,
  burst: false,
  keyId: "k1",
  projectId: "p1",
});

const facts = (overrides: Partial<ProjectWork["facts"] extends Map<string, infer F> ? F : never> = {}) => ({
  reporterId: "owner-ada",
  beneficiaryUserId: "owner-ada",
  assigneeId: null,
  createdByAgentId: "agent-owner-ada",
  createdByAgent: { ownerUserId: "owner-ada" },
  pullRequestUrl: null,
  claims: [],
  confirmerOwners: [],
  deliveryOwners: [],
  testerOwners: [],
  ...overrides,
});

/** Who filed an idea and who already judged it (#idea-table): ideas are not issues. */
const ideaFacts = (overrides: Partial<ProjectWork["ideaFacts"] extends Map<string, infer F> ? F : never> = {}) => ({
  reporterId: "owner-ada",
  beneficiaryUserId: "owner-ada",
  assigneeId: null,
  createdByAgent: { ownerUserId: "owner-ada" },
  claims: [],
  verdictOwners: [],
  ...overrides,
});

function work(overrides: Partial<ProjectWork> = {}): ProjectWork {
  return {
    tenantId: "t1",
    project: { id: "p1", slug: "ziki", name: "Ziki" },
    importance: [],
    ideas: [],
    toConvert: [],
    toReject: [],
    toReclaim: [],
    toSenseCheck: [],
    toReviewIdle: [],
    toClose: [],
    toDeliverStranded: [],
    toReconcile: [],
    toAwaitRelease: [],
    toRepair: [],
    toReportPr: [],
    prGates: new Map(),
    toConfirm: [],
    ideaThreshold: 3,
    tests: [],
    ready: [],
    bids: [],
    toAward: [],
    toInvestigate: [],
    comments: [],
    toAccept: [],
    toMerge: [],
    jobs: [],
    facts: new Map(),
    ideaFacts: new Map(),
    offerWindowSeconds: 1800,
    capacity: 2,
    governance: { thresholdOnly: false, managerVoteWeight: 3, closeThreshold: 3, awardThreshold: 3, acceptThreshold: 3 },
    ...overrides,
  };
}

const nothingMine: AgentWork = { offers: [], reviewOffers: [], jobReviewOffers: [], claims: [], unread: 0 };

/** One open bid on issue #1 (#bid-votes). */
const openBid = (overrides: Partial<ProjectWork["bids"][number]> = {}): ProjectWork["bids"][number] => ({
  id: "bid-ada",
  issue: { id: "b1", number: 1, title: "x" },
  agentName: "Ada's Claude",
  ownerIds: ["owner-ada"],
  by: "Ada",
  summary: "I will fix the redirect.",
  weightedVotes: 0,
  voters: [],
  load: 0,
  createdAt: new Date("2026-10-29T10:00:00Z"),
  ...overrides,
});

describe("itemsFor", () => {
  it("asks for a verdict on an idea, worth 1 point, until the owner gives one", () => {
    const idea = { id: "b1", number: 7, title: "Activity as an icon", score: 1 };
    const fresh = itemsFor(agent("working"), work({ ideas: [idea], ideaFacts: new Map([["b1", ideaFacts()]]) }), nothingMine);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ kind: "idea", points: 1, canAct: true, minimumRole: "working", idea: { id: "b1", number: 7 } });
    expect(fresh[0]).not.toHaveProperty("issue");
    expect(fresh[0].actions[0].path).toBe("/api/v1/ideas/b1/verdicts?projectId=p1");
    expect(fresh[0].actions.map((a) => a.name)).toEqual(["give_idea_verdict"]);
    expect(fresh[0].actions[0].cli).not.toContain("--votes");
    expect(fresh[0].detail).toContain("Score 1 of 3");

    const given = ideaFacts({ verdictOwners: ["owner-bob:working"] });
    expect(itemsFor(agent("working"), work({ ideas: [idea], ideaFacts: new Map([["b1", given]]) }), nothingMine)).toEqual([]);
  });

  it("stops asking for verdicts once an idea reaches the threshold (#727)", () => {
    const at = { id: "b1", number: 7, title: "x", score: 3 };
    const short = { id: "b2", number: 8, title: "y", score: 2 };
    const facts = new Map([["b1", ideaFacts()], ["b2", ideaFacts()]]);
    const items = itemsFor(agent("working"), work({ ideas: [at, short], ideaFacts: facts }), nothingMine);
    expect(items.map((i) => i.key)).toEqual(["idea:b2"]);
  });

  it("tells a manager agent it may give up to the project's manager vote weight", () => {
    const items = itemsFor(agent("manager"), work({ ideas: [{ id: "b1", number: 7, title: "x", score: 0 }], ideaFacts: new Map([["b1", ideaFacts()]]) }), nothingMine);
    expect(items[0].actions[0].cli).toContain("--votes 1-3");
    const heavier = work({
      ideas: [{ id: "b1", number: 7, title: "x", score: 0 }],
      ideaFacts: new Map([["b1", ideaFacts()]]),
      governance: { thresholdOnly: false, managerVoteWeight: 4, closeThreshold: 3, awardThreshold: 3, acceptThreshold: 3 },
    });
    expect(itemsFor(agent("manager"), heavier, nothingMine)[0].actions[0].cli).toContain("--votes 1-4");
  });

  it("asks for a verdict on the agent's own owner's ideas too", () => {
    const own = ideaFacts({ reporterId: "owner-bob", beneficiaryUserId: "owner-bob", createdByAgent: { ownerUserId: "owner-bob" } });
    const items = itemsFor(agent("working"), work({ ideas: [{ id: "b1", number: 7, title: "x", score: 0 }], ideaFacts: new Map([["b1", own]]) }), nothingMine);
    expect(items).toMatchObject([{ kind: "idea", canAct: true }]);
  });

  it("asks to confirm a converted issue at the confirmations route, and drops it once the owner gave an entry", () => {
    const issue = { id: "b1", number: 7, title: "x", confirmations: 1, needed: 2, confirmed: false };
    const items = itemsFor(agent("working"), work({ toConfirm: [issue], facts: new Map([["b1", facts()]]) }), nothingMine);
    expect(items[0]).toMatchObject({ kind: "confirm_issue", canAct: true });
    expect(items[0].detail).toContain("1 of 2 confirmations");
    expect(items[0].actions.map((a) => a.name)).toEqual(["confirm_issue"]);
    expect(items[0].actions[0].path).toContain("/api/v1/issues/b1/confirmations");
    expect(items[0].actions[0].cli).toContain("confirm-issue --id b1 --verdict confirm|reject|neutral --summary");

    // A worker agent's owner gave a working-class entry: not asked again (a manager agent still may give one).
    const done = facts({ confirmerOwners: ["owner-bob:working"] });
    expect(itemsFor(agent("working"), work({ toConfirm: [issue], facts: new Map([["b1", done]]) }), nothingMine)).toEqual([]);
  });

  it("lists an idea at the threshold as a task any agent can convert", () => {
    // The convert list comes from its own query, so ideas past the top of the verdict list still reach agents.
    const project = work({
      ideas: [{ id: "b2", number: 8, title: "y", score: 2 }],
      toConvert: [{ id: "b1", number: 7, title: "x", score: 3 }],
      ideaFacts: new Map([["b1", ideaFacts()], ["b2", ideaFacts()]]),
    });
    const forWorking = itemsFor(agent("working"), project, nothingMine).filter((item) => item.kind === "convert_idea");
    expect(forWorking).toHaveLength(1);
    expect(forWorking[0]).toMatchObject({ key: "convert_idea:b1", minimumRole: "working", canAct: true });
    expect(forWorking[0].blockedReason).toBeUndefined();
    expect(forWorking[0].actions.map((a) => [a.name, a.minimumRole])).toEqual([["list_idea_verdicts", "working"], ["convert_idea", "working"]]);
    const forManager = itemsFor(agent("manager"), project, nothingMine).find((item) => item.kind === "convert_idea");
    expect(forManager).toMatchObject({ canAct: true });
  });

  it("lists a bad idea as a manager task to reject (#idea-rejected)", () => {
    const project = work({ toReject: [{ id: "i1", number: 4, title: "x", totalVotes: 3, goodVotes: 1 }] });
    const forWorking = itemsFor(agent("working"), project, nothingMine).find((item) => item.kind === "reject_idea");
    expect(forWorking).toMatchObject({ key: "reject_idea:i1", minimumRole: "manager", canAct: false });
    const forManager = itemsFor(agent("manager"), project, nothingMine).find((item) => item.kind === "reject_idea");
    expect(forManager).toMatchObject({ canAct: true });
    expect(forManager!.actions.map((a) => a.name)).toEqual(["list_idea_verdicts", "reject_idea"]);
  });

  it("asks other agents for a sense check on stale in-progress work, not its holder or a past voter (#abandon)", () => {
    const since = new Date("2026-10-30T06:00:00Z");
    const check = { id: "b5", number: 5, title: "x", votes: 1, threshold: 3, holderOwners: ["owner-ada"], voters: ["owner-cara"], since };
    const items = itemsFor(agent("working"), work({ toSenseCheck: [check] }), nothingMine).filter((item) => item.kind === "sense_check");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "sense_check:b5", minimumRole: "working", canAct: true });
    expect(items[0].detail).toContain("1 of 3 Abandoned votes");
    expect(items[0].actions[0]).toMatchObject({ name: "vote_abandoned", method: "POST", path: expect.stringContaining("/api/v1/issues/b5/abandon-votes") });

    for (const ownerId of ["owner-ada", "owner-cara"]) {
      expect(itemsFor(agent("working", ownerId), work({ toSenseCheck: [check] }), nothingMine).some((item) => item.kind === "sense_check")).toBe(false);
    }
  });

  it("lets a manager vote on a sense check, whoever else already voted (#idle)", () => {
    const since = new Date("2026-10-30T06:00:00Z");
    const check = { id: "b5", number: 5, title: "x", votes: 2, threshold: 3, holderOwners: ["owner-ada"], voters: ["owner-cara", "owner-eli"], since };
    const item = itemsFor(agent("manager", "owner-dana"), work({ toSenseCheck: [check] }), nothingMine).find((i) => i.kind === "sense_check");
    expect(item).toMatchObject({ key: "sense_check:b5", canAct: true });
    expect(item!.detail).toContain("as a manager agent your vote counts 3");
  });

  it("asks an independent manager whether idle In progress work nobody holds was abandoned (#idle)", () => {
    const since = new Date("2026-10-31T06:00:00Z");
    const idle = { id: "b8", number: 8, title: "x", since, idleHours: 6, pullRequestUrl: null };
    const project = work({ toReviewIdle: [idle], facts: new Map([["b8", facts({ assigneeId: "owner-cara" })]]) });

    const item = itemsFor(agent("manager", "owner-dana"), project, nothingMine).find((i) => i.kind === "review_idle");
    expect(item).toMatchObject({ key: `review_idle:b8:${since.toISOString()}`, minimumRole: "manager", canAct: true, issue: { id: "b8", number: 8 } });
    expect(item!.detail).toContain("#8 has been In progress for 6h with no update");
    expect(item!.detail).toContain("nobody holds it: decide whether it was abandoned");
    expect(item!.detail).toContain("leave it");
    expect(item!.actions).toEqual([
      { name: "reclaim_issue", minimumRole: "manager", method: "POST", path: "/api/v1/issues/b8/reclaim?projectId=p1", cli: "reclaim-issue --id b8" },
    ]);

    // Listed for a working agent, who can't act; blocked for the assignee's or filer's manager.
    expect(itemsFor(agent("working", "owner-eli"), project, nothingMine).find((i) => i.kind === "review_idle")).toMatchObject({
      canAct: false,
      blockedReason: "Needs a manager agent.",
    });
    for (const ownerId of ["owner-cara", "owner-ada"]) {
      expect(itemsFor(agent("manager", ownerId), project, nothingMine).find((i) => i.kind === "review_idle")).toMatchObject({ canAct: false });
    }

    // A linked pull request is named, to check before deciding.
    const pr = "https://github.com/emerjent/ziki/pull/9";
    const linked = work({ toReviewIdle: [{ ...idle, pullRequestUrl: pr }], facts: new Map([["b8", facts()]]) });
    expect(itemsFor(agent("manager", "owner-dana"), linked, nothingMine).find((i) => i.kind === "review_idle")!.detail).toContain(pr);
  });

  it("lists a stale hold for any agent to reclaim (#reclaim)", () => {
    const items = itemsFor(agent("working"), work({ toReclaim: [{ id: "b6", number: 6, title: "x", reason: "offer_expired" }] }), nothingMine);
    const item = items.find((i) => i.kind === "reclaim_issue");
    expect(item).toMatchObject({ key: "reclaim_issue:b6:offer_expired", minimumRole: "working", canAct: true });
    expect(item!.actions[0]).toMatchObject({ name: "reclaim_issue", method: "POST", path: expect.stringContaining("/api/v1/issues/b6/reclaim") });
  });

  it("leaves out fixes the owner already tested at this pull request", () => {
    const pr = "https://github.com/emerjent/ziki/pull/1";
    const tested = facts({ pullRequestUrl: pr, testerOwners: [{ ownerUserId: "owner-bob", pullRequestUrl: pr }] });
    const items = itemsFor(agent("working"), work({ tests: [{ id: "b1", number: 7, title: "x", pullRequestUrl: pr }], facts: new Map([["b1", tested]]) }), nothingMine);
    expect(items).toEqual([]);
  });

  it("lists manager and merger work for a working agent without letting it act", () => {
    const project = work({
      ready: [{ id: "b1", number: 1, title: "x", importance: 3 }],
      toAward: [{ id: "b4", number: 4, title: "w", bids: [openBid({ issue: { id: "b4", number: 4, title: "w" }, weightedVotes: 3 })] }],
      toClose: [{ id: "b5", number: 5, title: "v", reason: "superseded", votes: 3, tallies: [{ reason: "superseded", votes: 3 }], threshold: 3, suggestions: 1, summaries: ["#2 covers it."], suggesters: ["owner-cara"], duplicateOfNumber: null }],
      toAccept: [{ id: "b2", number: 2, title: "y" }],
      toMerge: [{ id: "b3", number: 3, title: "z" }],
      facts: new Map([["b2", facts()], ["b3", facts()]]),
    });
    const items = itemsFor(agent("working"), project, nothingMine);
    const byKind = Object.fromEntries(items.map((item) => [item.kind, item]));
    expect(byKind.ready_issue).toMatchObject({ canAct: true, minimumRole: "working" });
    expect(byKind).not.toHaveProperty("dispatch");
    // A bid at the threshold is any agent's to award (#bid-votes).
    expect(byKind.award_bid).toMatchObject({ canAct: true, minimumRole: "working" });
    expect(byKind.close_issue).toMatchObject({ canAct: false, minimumRole: "manager", blockedReason: "Needs a manager agent." });
    expect(byKind.accept_fix).toMatchObject({ canAct: false, minimumRole: "manager" });
    expect(byKind.merge_fix).toMatchObject({ canAct: false, minimumRole: "merger", blockedReason: "Needs a merger agent." });

    const merger = Object.fromEntries(itemsFor(agent("merger"), project, nothingMine).map((item) => [item.kind, item]));
    expect(merger.award_bid.canAct).toBe(true);
    expect(merger.close_issue.canAct).toBe(true);
    expect(merger.accept_fix.canAct).toBe(true);
    expect(merger.merge_fix.canAct).toBe(true);
  });

  it("asks to bid on a ready issue, with no offer request", () => {
    const [item] = itemsFor(agent("working"), work({ ready: [{ id: "b1", number: 1, title: "x", importance: 3 }] }), nothingMine);
    expect(item).toMatchObject({ kind: "ready_issue", title: "Bid on #1", canAct: true });
    expect(item.actions.map((a) => a.name)).toEqual(["bid"]);
    expect(item.actions[0]).toMatchObject({ method: "POST", path: "/api/v1/issues/b1/bid?projectId=p1" });
  });

  it("asks agents to vote for an open bid, not a working agent of its own owner, nor a past voter (#bid-votes)", () => {
    const bid = openBid({ weightedVotes: 1, voters: ["owner-cara"] });
    const items = itemsFor(agent("working"), work({ bids: [bid] }), nothingMine).filter((item) => item.kind === "review_bid");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "review_bid:bid-ada", minimumRole: "working", canAct: true, issue: { id: "b1", number: 1 } });
    expect(items[0].detail).toContain("1 of 3");
    expect(items[0].detail).toContain("once a bid has 3, any agent can award it");
    expect(items[0].actions).toEqual([
      { name: "vote_bid", minimumRole: "working", method: "POST", path: "/api/v1/bids/bid-ada/votes?projectId=p1", cli: "vote-bid --id bid-ada" },
    ]);

    for (const ownerId of ["owner-ada", "owner-cara"]) {
      expect(itemsFor(agent("working", ownerId), work({ bids: [bid] }), nothingMine).some((item) => item.kind === "review_bid")).toBe(false);
    }
  });

  it("asks a manager to vote too, its own owner's bid included, and says its vote can reach the threshold alone (#bid-votes)", () => {
    const bid = openBid({ ownerIds: ["owner-dana"] });
    const item = itemsFor(agent("manager", "owner-dana"), work({ bids: [bid] }), nothingMine).find((i) => i.kind === "review_bid");
    expect(item).toMatchObject({ key: "review_bid:bid-ada", canAct: true });
    expect(item!.detail).toContain("Your vote counts 3 and can reach the threshold alone.");
    // Once the manager's owner voted, the item goes.
    expect(itemsFor(agent("manager", "owner-dana"), work({ bids: [{ ...bid, voters: ["owner-dana"] }] }), nothingMine).some((i) => i.kind === "review_bid")).toBe(false);
  });

  it("asks to investigate an Open issue and comment, not on one its owner filed or already commented on (#comment-votes)", () => {
    const issue = { id: "b1", number: 1, title: "x", reporterOwners: ["owner-ada"], commenterOwners: ["owner-cara"] };
    const items = itemsFor(agent("working"), work({ toInvestigate: [issue] }), nothingMine).filter((item) => item.kind === "investigate_issue");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "investigate_issue:b1", title: "Investigate #1 and comment", minimumRole: "working", canAct: true, issue: { id: "b1", number: 1 } });
    expect(items[0].detail).toContain("root cause");
    expect(items[0].actions.map((action) => action.name)).toEqual(["get_issue", "comment"]);
    expect(items[0].actions[1]).toMatchObject({ method: "POST", path: "/api/v1/issues/b1/comments?projectId=p1" });

    for (const ownerId of ["owner-ada", "owner-cara"]) {
      expect(itemsFor(agent("working", ownerId), work({ toInvestigate: [issue] }), nothingMine).some((item) => item.kind === "investigate_issue")).toBe(false);
    }
  });

  it("asks other people's agents to upvote a comment on an Open issue, not its author's or a past voter's (#comment-votes)", () => {
    const comment = {
      id: "c1",
      issue: { id: "b1", number: 1, title: "x" },
      by: "Ada's Claude for Ada",
      ownerIds: ["owner-ada"],
      excerpt: "The redirect drops the session cookie in middleware.ts.",
      votes: 1,
      voters: ["owner-cara"],
      createdAt: new Date("2026-10-29T10:00:00Z"),
    };
    const items = itemsFor(agent("working"), work({ comments: [comment] }), nothingMine).filter((item) => item.kind === "review_comment");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "review_comment:c1", minimumRole: "working", canAct: true, issue: { id: "b1", number: 1 } });
    expect(items[0].detail).toContain("1 upvote so far");
    expect(items[0].actions).toEqual([
      { name: "upvote_comment", minimumRole: "working", method: "POST", path: "/api/v1/comments/c1/votes?projectId=p1", cli: "upvote-comment --id c1" },
    ]);

    for (const ownerId of ["owner-ada", "owner-cara"]) {
      expect(itemsFor(agent("working", ownerId), work({ comments: [comment] }), nothingMine).some((item) => item.kind === "review_comment")).toBe(false);
    }
  });

  it("lets any agent award a bid that reached the threshold, its own owner's too, most voted first (#bid-votes)", () => {
    const issue = { id: "b1", number: 1, title: "x" };
    const bids = [
      openBid({ id: "bid-ada", weightedVotes: 1 }),
      openBid({ id: "bid-dana", agentName: "Dana's Claude", ownerIds: ["owner-dana"], by: "Dana", weightedVotes: 3 }),
      openBid({ id: "bid-cara", agentName: "Cara's Claude", ownerIds: ["owner-cara"], by: "Cara", weightedVotes: 5 }),
    ];
    const project = work({ toAward: [{ ...issue, bids }] });

    for (const caller of [agent("working", "owner-eli"), agent("manager", "owner-dana")]) {
      const item = itemsFor(caller, project, nothingMine).find((i) => i.kind === "award_bid");
      expect(item).toMatchObject({ key: "award_bid:b1", minimumRole: "working", canAct: true, title: "Award #1 to Cara's Claude: its bid has 5 of 3 votes" });
      // Only the bids at the threshold, the most voted first; the one below it is not offered.
      expect(item!.actions.map((a) => a.cli)).toEqual(["award-bid --id bid-cara", "award-bid --id bid-dana"]);
      expect(item!.actions[0]).toMatchObject({ name: "award_bid", minimumRole: "working", method: "POST", path: "/api/v1/bids/bid-cara/award?projectId=p1" });
      expect(item!.detail).toContain("Dana's Claude for Dana (3 of 3)");
    }
  });

  it("offers no award while every bid is below the threshold (#bid-votes)", () => {
    const issue = { id: "b1", number: 1, title: "x" };
    const project = work({ toAward: [{ ...issue, bids: [openBid({ weightedVotes: 2 })] }] });
    for (const level of ["working", "manager", "merger"] as const) {
      expect(itemsFor(agent(level, "owner-dana"), project, nothingMine).some((i) => i.kind === "award_bid")).toBe(false);
    }
  });

  it("shows each bidder's load and offers no award for a bid at capacity (#bidder-capacity)", () => {
    const issue = { id: "b1", number: 1, title: "x" };
    const bids = [
      openBid({ id: "bid-pixel", agentName: "Pixel", ownerIds: ["owner-pix"], by: "Pix", weightedVotes: 5, load: 2 }),
      openBid({ id: "bid-cara", agentName: "Cara's Claude", ownerIds: ["owner-cara"], by: "Cara", weightedVotes: 3, load: 1 }),
    ];
    const item = itemsFor(agent("working", "owner-eli"), work({ toAward: [{ ...issue, bids }] }), nothingMine).find((i) => i.kind === "award_bid");
    expect(item).toMatchObject({ canAct: true, title: "Award #1 to Cara's Claude: its bid has 3 of 3 votes" });
    expect(item!.detail).toContain("Pixel: 2 of 2 — at capacity");
    expect(item!.detail).toContain("Cara's Claude: 1 of 2");
    expect(item!.actions.map((a) => a.cli)).toEqual(["award-bid --id bid-cara"]);
  });

  it("keeps the award item but blocks it when every bidder at the threshold is at capacity (#bidder-capacity)", () => {
    const issue = { id: "b1", number: 1, title: "x" };
    const bids = [
      openBid({ id: "bid-pixel", agentName: "Pixel", ownerIds: ["owner-pix"], by: "Pix", weightedVotes: 3, load: 2 }),
      openBid({ id: "bid-cara", agentName: "Cara's Claude", ownerIds: ["owner-cara"], by: "Cara", weightedVotes: 4, load: 3 }),
    ];
    const item = itemsFor(agent("working", "owner-eli"), work({ toAward: [{ ...issue, bids }] }), nothingMine).find((i) => i.kind === "award_bid");
    expect(item).toMatchObject({
      canAct: false,
      blockedReason: "every bidder is at capacity; wait or ask for more bids",
      actions: [],
    });
  });

  it("in a threshold-only project, asks for votes on each bid and says the crossing vote awards it", () => {
    const governance = { thresholdOnly: true, managerVoteWeight: 3, closeThreshold: 3, awardThreshold: 3, acceptThreshold: 3 };
    const bid = openBid({ weightedVotes: 2 });
    const item = itemsFor(agent("working", "owner-eli"), work({ governance, bids: [bid] }), nothingMine).find((i) => i.kind === "review_bid");
    expect(item).toMatchObject({ canAct: true });
    expect(item!.detail).toContain("the vote that reaches the threshold awards it");
  });

  it("asks a manager to close an issue for its leading reason once that reason reaches the threshold (#close-reasons)", () => {
    const project = work({ toClose: [{
      id: "b5", number: 5, title: "v", reason: "not_reproducible", votes: 4,
      tallies: [{ reason: "not_reproducible", votes: 4 }, { reason: "superseded", votes: 1 }],
      threshold: 3, suggestions: 3, summaries: ["Passes on main.", "Can't reproduce it."], suggesters: ["owner-cara", "owner-dan", "owner-eli"], duplicateOfNumber: null,
    }] });
    const item = itemsFor(agent("manager"), project, nothingMine).find((i) => i.kind === "close_issue");
    expect(item).toMatchObject({ key: "close_issue:b5", minimumRole: "manager", canAct: true, title: "Close #5 as not reproducible?" });
    expect(item!.detail).toContain("3 suggestions; leading reason not reproducible");
    expect(item!.detail).toContain("4 of 3 votes");
    expect(item!.detail).toContain("Other reasons, counted apart: superseded 1.");
    expect(item!.detail).toContain("not superseded by default");
    expect(item!.detail).toContain('"Passes on main." "Can\'t reproduce it."');
    expect(item!.actions).toEqual([
      { name: "close_issue", minimumRole: "manager", method: "POST", path: "/api/v1/issues/b5/close?projectId=p1", cli: "close-issue --id b5 --reason not_reproducible --evidence <what shows it>" },
    ]);
    expect(itemsFor(agent("working"), project, nothingMine).find((i) => i.kind === "close_issue")).toMatchObject({ canAct: false });
  });

  it("names the other issue when the leading reason is duplicate (#close-reasons)", () => {
    const project = work({ toClose: [{
      id: "b5", number: 5, title: "v", reason: "duplicate", votes: 3, tallies: [{ reason: "duplicate", votes: 3 }],
      threshold: 3, suggestions: 1, summaries: ["#2 owns it."], suggesters: ["owner-dan"], duplicateOfNumber: 2,
    }] });
    const item = itemsFor(agent("manager"), project, nothingMine).find((i) => i.kind === "close_issue");
    expect(item).toMatchObject({ title: "Close #5 as duplicate?" });
    expect(item!.detail).toContain("leading reason duplicate of #2");
    expect(item!.actions[0].cli).toBe("close-issue --id b5 --reason duplicate --duplicate-of 2 --evidence <what shows it>");
  });

  it("asks an independent manager to deliver a stranded pull request on the holder's behalf (#stranded-delivery)", () => {
    const pr = "https://github.com/emerjent/ziki/pull/615";
    const stranded = {
      id: "b7",
      number: 615,
      title: "x",
      pullRequestUrl: pr,
      creditedUserId: "owner-cara",
      creditedName: "Cara",
      linkedAt: new Date("2026-10-01T10:00:00Z"),
      goodVerdicts: 3,
      needed: 2,
    };
    const project = work({ toDeliverStranded: [stranded], facts: new Map([["b7", facts({ assigneeId: "owner-cara", pullRequestUrl: pr })]]) });

    const item = itemsFor(agent("manager", "owner-dana"), project, nothingMine).find((i) => i.kind === "deliver_stranded");
    expect(item).toMatchObject({ key: `deliver_stranded:b7:${pr}`, minimumRole: "manager", canAct: true, title: "Deliver #615 on the holder's behalf" });
    expect(item!.detail).toContain("3 of 2 good-to-merge judgements");
    expect(item!.detail).toContain("for Cara");
    const deliver = item!.actions.find((a) => a.name === "deliver");
    expect(deliver).toMatchObject({ minimumRole: "manager", method: "POST", path: "/api/v1/issues/b7/delivery?projectId=p1" });
    expect(deliver!.cli).toContain(`deliver --id b7 --pull-request-url ${pr}`);

    // Shown to a working agent, who can't act.
    expect(itemsFor(agent("working", "owner-eli"), project, nothingMine).find((i) => i.kind === "deliver_stranded")).toMatchObject({
      canAct: false,
      blockedReason: "Needs a manager agent.",
    });
    // Not for a manager whose owner is credited (the assignee here) or filed it.
    for (const ownerId of ["owner-cara", "owner-ada"]) {
      expect(itemsFor(agent("manager", ownerId), project, nothingMine).find((i) => i.kind === "deliver_stranded")).toMatchObject({ canAct: false });
    }
    // Credited through the agent that linked it, not the assignee: still blocked.
    const linkedBy = work({ toDeliverStranded: [{ ...stranded, creditedUserId: "owner-finn" }], facts: new Map([["b7", facts({ pullRequestUrl: pr })]]) });
    expect(itemsFor(agent("manager", "owner-finn"), linkedBy, nothingMine).find((i) => i.kind === "deliver_stranded")).toMatchObject({
      canAct: false,
      blockedReason: "Your owner is credited on this issue.",
    });
  });

  it("blocks deliver_stranded and offers a reclaim when the pull request is reported 404, and says so on the issue's other items", () => {
    const pr = "https://github.com/emerjent/ziki/pull/615";
    const stranded = {
      id: "b7",
      number: 615,
      title: "x",
      pullRequestUrl: pr,
      creditedUserId: "owner-cara",
      creditedName: "Cara",
      linkedAt: new Date("2026-10-01T10:00:00Z"),
      goodVerdicts: 3,
      needed: 2,
    };
    const gone = prIssue("b7", 615, pr, "in_progress", prReport({ bugId: "b7", pullRequestUrl: pr, state: "not_found", headSha: null, checks: null, mergeable: null }));
    expect(gone.gate.broken).toBe("not_found");
    const project = work({
      toDeliverStranded: [stranded],
      toSenseCheck: [{ id: "b7", number: 615, title: "x", votes: 0, threshold: 3, holderOwners: ["owner-cara"], voters: [], since: null }],
      prGates: new Map([["b7", gone.gate]]),
      facts: new Map([["b7", facts({ assigneeId: "owner-cara", pullRequestUrl: pr })]]),
    });
    const items = itemsFor(agent("manager", "owner-dana"), project, nothingMine);
    const item = items.find((i) => i.kind === "deliver_stranded");
    expect(item).toMatchObject({ canAct: false });
    expect(item!.blockedReason).toContain("doesn't exist on GitHub (404)");
    expect(item!.blockedReason).toContain("Reclaim it if it is idle.");
    // The reason is the block, not repeated in the detail.
    expect(item!.detail).not.toContain("doesn't exist on GitHub");
    expect(item!.actions.map((a) => a.name)).toEqual(["list_test_verdicts", "deliver", "reclaim_issue"]);
    expect(item!.actions[2]).toMatchObject({ minimumRole: "manager", method: "POST", path: "/api/v1/issues/b7/reclaim?projectId=p1" });
    // Other items about the issue carry the reason in their detail.
    expect(items.find((i) => i.kind === "sense_check")!.detail).toContain(gone.gate.reason!);
  });

  it("blocks a manager from accepting a fix it is not independent of", () => {
    const own = facts({ reporterId: "owner-dana", beneficiaryUserId: "owner-dana" });
    const items = itemsFor(agent("manager", "owner-dana"), work({ toAccept: [{ id: "b2", number: 2, title: "y" }], facts: new Map([["b2", own]]) }), nothingMine);
    expect(items[0]).toMatchObject({ kind: "accept_fix", canAct: false });
    expect(items[0].blockedReason).toMatch(/Your owner/);
  });

  it("asks an independent manager to resolve a fix reported merged into the default branch (#reconcile-merged)", () => {
    const report = prReport({ id: "rep5", bugId: "b5", state: "merged", mergedInto: "main", inDefaultBranch: true, mergeCommitSha: "merge-sha" });
    const issue = prIssue("b5", 552, PR, "ready_to_merge", report);
    const project = work({
      toMerge: [{ id: "b5", number: 552, title: "Fix" }],
      toReconcile: [issue],
      prGates: new Map([["b5", issue.gate]]),
      facts: new Map([["b5", facts({ pullRequestUrl: PR })]]),
    });
    const items = itemsFor(agent("manager", "owner-dana"), project, nothingMine);
    const item = items.find((i) => i.kind === "reconcile_merged");
    expect(item).toMatchObject({ key: `reconcile_merged:b5:${PR}:rep5`, minimumRole: "manager", canAct: true, issue: { id: "b5", number: 552 } });
    expect(item!.detail).toContain(`Erin's agent reported ${PR} merged into main, and the default branch contains it`);
    expect(item!.actions.map((a) => [a.name, a.path])).toEqual([["resolve_merged", "/api/v1/issues/b5/resolve?projectId=p1"]]);
    // Reported merged already: no merge item for it.
    expect(items.some((i) => i.kind === "merge_fix")).toBe(false);
    // A working agent sees it but can't act; a manager whose owner filed it can't either.
    expect(itemsFor(agent("working", "owner-eli"), project, nothingMine).find((i) => i.kind === "reconcile_merged")).toMatchObject({ canAct: false });
    expect(itemsFor(agent("manager", "owner-ada"), project, nothingMine).find((i) => i.kind === "reconcile_merged")).toMatchObject({ canAct: false });
  });

  it("offers no accept for a fix reported merged into staging, and lists it as awaiting release instead", () => {
    const report = prReport({ id: "rep3", state: "merged", mergedInto: "staging", inDefaultBranch: false });
    const issue = prIssue("b2", 552, PR, "done", report);
    const project = work({
      toAccept: [{ id: "b2", number: 552, title: "Fix" }],
      toAwaitRelease: [issue],
      prGates: new Map([["b2", issue.gate]]),
      facts: new Map([["b2", facts({ pullRequestUrl: PR })]]),
    });
    for (const level of ["manager", "merger"] as const) {
      const items = itemsFor(agent(level, "owner-dana"), project, nothingMine);
      expect(items.some((i) => i.kind === "accept_fix")).toBe(false);
      const wait = items.find((i) => i.kind === "await_release");
      expect(wait).toMatchObject({ key: `await_release:b2:${PR}:rep3`, minimumRole: "manager", canAct: false, issue: { id: "b2", number: 552 } });
      expect(wait!.blockedReason).toContain('Merged into "staging"');
      expect(wait!.detail).toContain("merged into staging, not yet in the default branch");
      expect(wait!.actions.map((a) => [a.name, a.path])).toEqual([["report_pr_status", "/api/v1/issues/b2/pull-request-status?projectId=p1"]]);
    }
  });

  it("blocks the accept until an independent agent reports the pull request, then follows the report", () => {
    const fix = { id: "b2", number: 552, title: "Fix" };
    const withGate = (report: StoredPullRequestReport | null) =>
      work({ toAccept: [fix], prGates: new Map([["b2", prIssue("b2", 552, PR, "done", report).gate]]), facts: new Map([["b2", facts({ pullRequestUrl: PR })]]) });
    const unreported = itemsFor(agent("manager", "owner-dana"), withGate(null), nothingMine).find((i) => i.kind === "accept_fix");
    expect(unreported).toMatchObject({ canAct: false });
    expect(unreported!.blockedReason).toMatch(/^No agent has reported this pull request's state yet\./);

    const failing = itemsFor(agent("manager", "owner-dana"), withGate(prReport({ checks: "failing" })), nothingMine).find((i) => i.kind === "accept_fix");
    expect(failing).toMatchObject({ canAct: false, blockedReason: "The latest report says its checks are failing: the author fixes them and pushes." });

    expect(itemsFor(agent("manager", "owner-dana"), withGate(prReport()), nothingMine).find((i) => i.kind === "accept_fix")).toMatchObject({ canAct: true });
    // Not independent still says so first.
    expect(itemsFor(agent("manager", "owner-ada"), withGate(prReport()), nothingMine).find((i) => i.kind === "accept_fix")).toMatchObject({
      canAct: false,
      blockedReason: "Your owner filed, claimed or is credited on this issue.",
    });
  });

  it("asks the merger to merge on GitHub, report it and resolve it, blocked until the report allows it", () => {
    const fix = { id: "b3", number: 553, title: "Fix" };
    const withGate = (report: StoredPullRequestReport | null) =>
      work({ toMerge: [fix], prGates: new Map([["b3", prIssue("b3", 553, PR, "ready_to_merge", report).gate]]), facts: new Map([["b3", facts({ pullRequestUrl: PR })]]) });
    const item = itemsFor(agent("merger", "owner-dana"), withGate(prReport({ bugId: "b3" })), nothingMine).find((i) => i.kind === "merge_fix");
    expect(item).toMatchObject({ key: "merge_fix:b3", title: "Merge the accepted fix for #553 on GitHub", minimumRole: "merger", canAct: true });
    expect(item!.actions.map((a) => [a.name, a.path])).toEqual([
      ["report_pr_status", "/api/v1/issues/b3/pull-request-status?projectId=p1"],
      ["resolve_merged", "/api/v1/issues/b3/resolve?projectId=p1"],
    ]);
    const unreported = itemsFor(agent("merger", "owner-dana"), withGate(null), nothingMine).find((i) => i.kind === "merge_fix");
    expect(unreported).toMatchObject({ canAct: false });
    expect(unreported!.blockedReason).toMatch(/^No agent has reported/);
  });

  it("asks an independent agent to check a pull request on GitHub and report it, not the issue's own side (#pr-reports)", () => {
    const pr9 = "https://github.com/emerjent/ziki/pull/9";
    const unreported = prIssue("b3", 9, pr9, "delivered");
    const project = (report: StoredPullRequestReport | null, why: string) => work({
      toReportPr: [{ ...prIssue("b3", 9, pr9, "delivered", report), why }],
      prGates: new Map([["b3", unreported.gate]]),
      facts: new Map([["b3", facts({ pullRequestUrl: pr9, assigneeId: "owner-cara", deliveryOwners: ["owner-cara", "owner-finn"] })]]),
    });
    const fresh = project(null, "Nobody has reported this pull request's state yet.");
    const item = itemsFor(agent("working", "owner-eli"), fresh, nothingMine).find((i) => i.kind === "report_pr_status");
    expect(item).toMatchObject({
      key: `report_pr_status:b3:${pr9}:none`,
      title: "Check PR #9 on GitHub and report its state",
      minimumRole: "working",
      canAct: true,
      issue: { id: "b3", number: 9 },
    });
    expect(item!.detail).toContain(`#9 links ${pr9}. Nobody has reported this pull request's state yet.`);
    expect(item!.actions).toEqual([expect.objectContaining({ name: "report_pr_status", minimumRole: "working", method: "POST", path: "/api/v1/issues/b3/pull-request-status?projectId=p1" })]);
    expect(item!.actions[0].cli).toContain(`report-pr-status --id b3 --pull-request-url ${pr9}`);

    // Not for the filer, the assignee, or whoever delivered it.
    for (const ownerId of ["owner-ada", "owner-cara", "owner-finn"]) {
      expect(itemsFor(agent("manager", ownerId), fresh, nothingMine).some((i) => i.kind === "report_pr_status")).toBe(false);
    }

    // An old report: the key moves with it, and the detail names it.
    const old = project(prReport({ id: "rep9", bugId: "b3", pullRequestUrl: pr9 }), "The latest report is 7 hours old.");
    const again = itemsFor(agent("working", "owner-eli"), old, nothingMine).find((i) => i.kind === "report_pr_status");
    expect(again!.key).toBe(`report_pr_status:b3:${pr9}:rep9`);
    expect(again!.detail).toContain(`The latest report (open) is from Erin's agent at ${REPORTED_AT.toISOString()}.`);
  });

  it("says a link under the old repository name needs repairing, on the issue's items and as a manager item (#triage)", () => {
    const old = "https://github.com/Zedu-Endor/issue-tracker/pull/552";
    const broken = prIssue("b2", 552, old, "done");
    const project = work({
      toAccept: [{ id: "b2", number: 552, title: "Old fix" }],
      toRepair: [{ ...broken, linkState: "old_repository" }],
      prGates: new Map([["b2", broken.gate]]),
      facts: new Map([["b2", facts({ pullRequestUrl: old })]]),
    });
    const items = itemsFor(agent("manager", "owner-dana"), project, nothingMine);
    const accept = items.find((i) => i.kind === "accept_fix");
    expect(accept!.detail).toContain("PR belongs to the old repository: repair it first.");
    expect(accept).toMatchObject({ canAct: false });
    expect(accept!.blockedReason).toContain("uses an old name of the project's repository");
    const repair = items.find((i) => i.kind === "repair_pull_request");
    expect(repair).toMatchObject({ key: `repair_pull_request:b2:${old}`, minimumRole: "manager", canAct: true, issue: { id: "b2", number: 552 } });
    expect(repair!.actions.map((a) => [a.name, a.path])).toEqual([["repair_pull_request", "/api/v1/issues/b2/pull-request?projectId=p1"]]);
    // A working agent sees it but can't act; a manager whose owner filed it can't either.
    expect(itemsFor(agent("working", "owner-eli"), project, nothingMine).find((i) => i.kind === "repair_pull_request")).toMatchObject({ canAct: false });
    expect(itemsFor(agent("manager", "owner-ada"), project, nothingMine).find((i) => i.kind === "repair_pull_request")).toMatchObject({ canAct: false });
  });

  it("names a link in another repository as one to repair or replace", () => {
    const elsewhere = "https://github.com/someone/fork/pull/3";
    const project = work({
      toRepair: [{ ...prIssue("b6", 3, elsewhere, "in_progress"), linkState: "other_repository" }],
      facts: new Map([["b6", facts({ pullRequestUrl: elsewhere })]]),
    });
    const repair = itemsFor(agent("manager", "owner-dana"), project, nothingMine).find((i) => i.kind === "repair_pull_request");
    expect(repair!.detail).toContain("PR is not in the project's repository");
  });

  it("lists repair_pull_request as waiting for a manager when a working agent can't do it", () => {
    const old = "https://github.com/Zedu-Endor/issue-tracker/pull/552";
    const project = work({
      toRepair: [{ ...prIssue("b2", 552, old, "delivered"), linkState: "old_repository" }],
      facts: new Map([["b2", facts({ pullRequestUrl: old })]]),
    });
    const { waiting } = waitingForOthers("working", itemsFor(agent("working", "owner-eli"), project, nothingMine));
    expect(waiting).toContainEqual(expect.objectContaining({ kind: "repair_pull_request", count: 1, minimumRole: "manager" }));
  });

  it("puts offers addressed to the agent first, with their deadline", () => {
    const offeredAt = new Date("2026-10-29T10:00:00Z");
    const mine: AgentWork = {
      ...nothingMine,
      offers: [{ id: "o1", offeredAt, bug: { id: "b9", number: 9, title: "Offered" } }],
    };
    const items = itemsFor(agent("working"), work({ ready: [{ id: "b1", number: 1, title: "x", importance: 3 }] }), mine);
    expect(items[0]).toMatchObject({ kind: "offer", key: "offer:o1", dueAt: "2026-10-29T10:30:00.000Z" });
    expect(items[0].actions[0]).toMatchObject({ name: "accept_offer", path: "/api/v1/offers/o1/accept", cli: "accept-offer --id o1" });
  });
});

describe("waitingForOthers", () => {
  const project = work({
    toConvert: [{ id: "b1", number: 7, title: "x", score: 4 }, { id: "b4", number: 9, title: "w", score: 3 }],
    toAccept: [{ id: "b2", number: 2, title: "y" }],
    toMerge: [{ id: "b3", number: 3, title: "z" }],
    facts: new Map([["b1", facts()], ["b2", facts()], ["b3", facts()], ["b4", facts()]]),
  });

  it("tells a working agent what waits for managers and mergers, though it can't do it", () => {
    const { waiting, lines } = waitingForOthers("working", itemsFor(agent("working"), project, nothingMine));
    expect(waiting).toEqual([
      { kind: "accept_fix", count: 1, minimumRole: "manager", what: "1 tested fix to accept or reject" },
      { kind: "merge_fix", count: 1, minimumRole: "merger", what: "1 accepted fix to merge on GitHub" },
    ]);
    expect(lines).toEqual([
      "Also open in this project, for a manager agent: 1 tested fix to accept or reject. You can't do it as a working agent, but it is work waiting to be done.",
      "Also open in this project, for a merger agent: 1 accepted fix to merge on GitHub. You can't do it as a working agent, but it is work waiting to be done.",
    ]);
  });

  it("tells a manager only about merger work, and a merger about nothing", () => {
    expect(waitingForOthers("manager", itemsFor(agent("manager"), project, nothingMine)).waiting.map((w) => w.kind)).toEqual(["merge_fix"]);
    expect(waitingForOthers("merger", itemsFor(agent("merger"), project, nothingMine))).toEqual({ waiting: [], lines: [] });
  });

  it("lets an agent convert its owner's own idea, and never lists converting as waiting for others", () => {
    const own = work({ toConvert: [{ id: "b1", number: 7, title: "x", score: 4 }], facts: new Map([["b1", facts({ reporterId: "owner-bob", beneficiaryUserId: "owner-bob" })]]) });
    for (const level of ["working", "manager"] as const) {
      const item = itemsFor(agent(level), own, nothingMine).find((i) => i.kind === "convert_idea");
      expect(item).toMatchObject({ canAct: true });
    }
    expect(waitingForOthers("working", itemsFor(agent("working"), project, nothingMine)).waiting.map((w) => w.kind)).not.toContain("convert_idea");
  });
});

describe("workEtag", () => {
  it("changes with the feed and stays the same for an equal one", () => {
    const feed = { items: [], ask: [] } as unknown as WorkFeed;
    expect(workEtag(feed)).toBe(workEtag({ ...feed }));
    expect(workEtag(feed)).not.toBe(workEtag({ ...feed, ask: ["new"] }));
    expect(workEtag(feed)).toMatch(/^W\/"[\w-]+"$/);
  });
});
