import { describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/agents/require-agent";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { itemsFor, waitingForOthers, workEtag, type AgentWork, type ProjectWork, type WorkFeed } from "./work";

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
    ideas: [],
    toConvert: [],
    toReject: [],
    toReclaim: [],
    toSenseCheck: [],
    toReviewIdle: [],
    toClose: [],
    toDeliverStranded: [],
    toReconcile: [],
    toRepair: [],
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
  votes: 0,
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

    const given = ideaFacts({ verdictOwners: ["owner-bob"] });
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

  it("leaves out the agent's own ideas", () => {
    const own = ideaFacts({ reporterId: "owner-bob", beneficiaryUserId: "owner-bob", createdByAgent: { ownerUserId: "owner-bob" } });
    const items = itemsFor(agent("working"), work({ ideas: [{ id: "b1", number: 7, title: "x", score: 0 }], ideaFacts: new Map([["b1", own]]) }), nothingMine);
    expect(items).toEqual([]);
  });

  it("asks to confirm a converted issue at the confirmations route, and drops it once the owner gave an entry", () => {
    const issue = { id: "b1", number: 7, title: "x", confirmations: 1, needed: 2 };
    const items = itemsFor(agent("working"), work({ toConfirm: [issue], facts: new Map([["b1", facts()]]) }), nothingMine);
    expect(items[0]).toMatchObject({ kind: "confirm_issue", canAct: true });
    expect(items[0].detail).toContain("1 of 2 confirmations");
    expect(items[0].actions.map((a) => a.name)).toEqual(["confirm_issue"]);
    expect(items[0].actions[0].path).toContain("/api/v1/issues/b1/confirmations");
    expect(items[0].actions[0].cli).toContain("confirm-issue --id b1 --verdict confirm|reject|neutral --summary");

    const done = facts({ confirmerOwners: ["owner-bob"] });
    expect(itemsFor(agent("working"), work({ toConfirm: [issue], facts: new Map([["b1", done]]) }), nothingMine)).toEqual([]);
  });

  it("lists an idea at the threshold as a manager task to convert", () => {
    // The convert list comes from its own query, so ideas past the top of the verdict list still reach managers.
    const project = work({
      ideas: [{ id: "b2", number: 8, title: "y", score: 2 }],
      toConvert: [{ id: "b1", number: 7, title: "x", score: 3 }],
      ideaFacts: new Map([["b1", ideaFacts()], ["b2", ideaFacts()]]),
    });
    const forWorking = itemsFor(agent("working"), project, nothingMine).filter((item) => item.kind === "convert_idea");
    expect(forWorking).toHaveLength(1);
    expect(forWorking[0]).toMatchObject({ key: "convert_idea:b1", minimumRole: "manager", canAct: false, blockedReason: "Needs a manager agent." });
    const forManager = itemsFor(agent("manager"), project, nothingMine).find((item) => item.kind === "convert_idea");
    expect(forManager).toMatchObject({ canAct: true });
    expect(forManager!.actions.map((a) => a.name)).toEqual(["list_idea_verdicts", "convert_idea"]);
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
      toAward: [{ id: "b4", number: 4, title: "w", bids: [openBid({ issue: { id: "b4", number: 4, title: "w" } })] }],
      toClose: [{ id: "b5", number: 5, title: "v", votes: 3, threshold: 3, suggestions: 1, summaries: ["#2 covers it."], suggesters: ["owner-cara"] }],
      toAccept: [{ id: "b2", number: 2, title: "y" }],
      toMerge: [{ id: "b3", number: 3, title: "z" }],
      facts: new Map([["b2", facts()], ["b3", facts()]]),
    });
    const items = itemsFor(agent("working"), project, nothingMine);
    const byKind = Object.fromEntries(items.map((item) => [item.kind, item]));
    expect(byKind.ready_issue).toMatchObject({ canAct: true, minimumRole: "working" });
    expect(byKind).not.toHaveProperty("dispatch");
    expect(byKind.award_bid).toMatchObject({ canAct: false, minimumRole: "manager", blockedReason: "Needs a manager agent." });
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

  it("asks other agents to vote for an open bid, not its own owner or a past voter (#bid-votes)", () => {
    const bid = openBid({ votes: 1, voters: ["owner-cara"] });
    const items = itemsFor(agent("working"), work({ bids: [bid] }), nothingMine).filter((item) => item.kind === "review_bid");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "review_bid:bid-ada", minimumRole: "working", canAct: true, issue: { id: "b1", number: 1 } });
    expect(items[0].detail).toContain("1 vote so far");
    expect(items[0].actions).toEqual([
      { name: "vote_bid", minimumRole: "working", method: "POST", path: "/api/v1/bids/bid-ada/votes?projectId=p1", cli: "vote-bid --id bid-ada" },
    ]);

    for (const ownerId of ["owner-ada", "owner-cara"]) {
      expect(itemsFor(agent("working", ownerId), work({ bids: [bid] }), nothingMine).some((item) => item.kind === "review_bid")).toBe(false);
    }
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

  it("asks a manager to award one of an open issue's bids, most voted first, never its own owner's (#bids-only-offers)", () => {
    const issue = { id: "b1", number: 1, title: "x" };
    const bids = [
      openBid({ id: "bid-ada", votes: 1 }),
      openBid({ id: "bid-dana", agentName: "Dana's Claude", ownerIds: ["owner-dana"], by: "Dana", votes: 5 }),
      openBid({ id: "bid-cara", agentName: "Cara's Claude", ownerIds: ["owner-cara"], by: "Cara", votes: 3 }),
    ];
    const project = work({ toAward: [{ ...issue, bids }] });

    const item = itemsFor(agent("manager", "owner-dana"), project, nothingMine).find((i) => i.kind === "award_bid");
    expect(item).toMatchObject({ key: "award_bid:b1", minimumRole: "manager", canAct: true, title: "Award one of the 3 bids on #1" });
    expect(item!.actions.map((a) => a.cli)).toEqual(["award-bid --id bid-cara", "award-bid --id bid-ada"]);
    expect(item!.actions[0]).toMatchObject({ name: "award_bid", method: "POST", path: "/api/v1/bids/bid-cara/award?projectId=p1" });
    expect(item!.detail).toContain("Dana's Claude for Dana (5 votes)");

    const onlyOwn = work({ toAward: [{ ...issue, bids: [bids[1]] }] });
    expect(itemsFor(agent("manager", "owner-dana"), onlyOwn, nothingMine).find((i) => i.kind === "award_bid")).toMatchObject({
      canAct: false,
      blockedReason: "Every bid on it is from your owner.",
      actions: [],
    });

    const forWorking = itemsFor(agent("working", "owner-eli"), project, nothingMine).find((i) => i.kind === "award_bid");
    expect(forWorking).toMatchObject({ canAct: false, blockedReason: "Needs a manager agent." });
  });

  it("shows each bidder's load and offers no award for a bid at capacity (#bidder-capacity)", () => {
    const issue = { id: "b1", number: 1, title: "x" };
    const bids = [
      openBid({ id: "bid-pixel", agentName: "Pixel", ownerIds: ["owner-pix"], by: "Pix", votes: 5, load: 2 }),
      openBid({ id: "bid-cara", agentName: "Cara's Claude", ownerIds: ["owner-cara"], by: "Cara", votes: 1, load: 1 }),
    ];
    const item = itemsFor(agent("manager", "owner-dana"), work({ toAward: [{ ...issue, bids }] }), nothingMine).find((i) => i.kind === "award_bid");
    expect(item).toMatchObject({ canAct: true });
    expect(item!.detail).toContain("Pixel: 2 of 2 — at capacity");
    expect(item!.detail).toContain("Cara's Claude: 1 of 2");
    expect(item!.actions.map((a) => a.cli)).toEqual(["award-bid --id bid-cara"]);
  });

  it("keeps the award item but blocks it when every bidder is at capacity (#bidder-capacity)", () => {
    const issue = { id: "b1", number: 1, title: "x" };
    const bids = [
      openBid({ id: "bid-pixel", agentName: "Pixel", ownerIds: ["owner-pix"], by: "Pix", load: 2 }),
      openBid({ id: "bid-cara", agentName: "Cara's Claude", ownerIds: ["owner-cara"], by: "Cara", load: 3 }),
    ];
    const item = itemsFor(agent("manager", "owner-dana"), work({ toAward: [{ ...issue, bids }] }), nothingMine).find((i) => i.kind === "award_bid");
    expect(item).toMatchObject({
      canAct: false,
      blockedReason: "every bidder is at capacity; wait or ask for more bids",
      actions: [],
    });
  });

  it("offers threshold-only votes only on bids under capacity (#bidder-capacity)", () => {
    const issue = { id: "b1", number: 1, title: "x" };
    const governance = { thresholdOnly: true, managerVoteWeight: 3, closeThreshold: 3, awardThreshold: 3, acceptThreshold: 3 };
    const bids = [
      openBid({ id: "bid-pixel", agentName: "Pixel", ownerIds: ["owner-pix"], by: "Pix", weightedVotes: 2, load: 2 }),
      openBid({ id: "bid-cara", agentName: "Cara's Claude", ownerIds: ["owner-cara"], by: "Cara", weightedVotes: 0, load: 0 }),
    ];
    const item = itemsFor(agent("working", "owner-eli"), work({ governance, toAward: [{ ...issue, bids }] }), nothingMine).find((i) => i.kind === "award_bid");
    expect(item).toMatchObject({ canAct: true });
    expect(item!.actions.map((a) => a.cli)).toEqual(["vote-bid --id bid-cara"]);

    const allFull = work({ governance, toAward: [{ ...issue, bids: bids.map((bid) => ({ ...bid, load: 2 })) }] });
    expect(itemsFor(agent("working", "owner-eli"), allFull, nothingMine).find((i) => i.kind === "award_bid")).toMatchObject({
      canAct: false,
      blockedReason: "every bidder is at capacity; wait or ask for more bids",
    });
  });

  it("asks a manager to close an issue whose suggestions reached the threshold (#close-superseded)", () => {
    const project = work({ toClose: [{ id: "b5", number: 5, title: "v", votes: 5, threshold: 3, suggestions: 3, summaries: ["#2 covers it.", "Same as #2."], suggesters: ["owner-cara", "owner-dan", "owner-eli"] }] });
    const item = itemsFor(agent("manager"), project, nothingMine).find((i) => i.kind === "close_issue");
    expect(item).toMatchObject({ key: "close_issue:b5", minimumRole: "manager", canAct: true, title: "Close #5 as superseded?" });
    expect(item!.detail).toContain("3 suggestions say another issue or change covers it (5 of 3 votes)");
    expect(item!.detail).toContain('"#2 covers it." "Same as #2."');
    expect(item!.actions).toEqual([
      { name: "close_issue", minimumRole: "manager", method: "POST", path: "/api/v1/issues/b5/close?projectId=p1", cli: "close-issue --id b5 --reason superseded --summary <why you close it>" },
    ]);
    expect(itemsFor(agent("working"), project, nothingMine).find((i) => i.kind === "close_issue")).toMatchObject({ canAct: false });
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

  it("blocks a manager from accepting a fix it is not independent of", () => {
    const own = facts({ reporterId: "owner-dana", beneficiaryUserId: "owner-dana" });
    const items = itemsFor(agent("manager", "owner-dana"), work({ toAccept: [{ id: "b2", number: 2, title: "y" }], facts: new Map([["b2", own]]) }), nothingMine);
    expect(items[0]).toMatchObject({ kind: "accept_fix", canAct: false });
    expect(items[0].blockedReason).toMatch(/Your owner/);
  });

  it("asks an independent manager to check whether a long-waiting fix is merged already (#reconcile-merged)", () => {
    const pr = "https://github.com/emerjent/ziki/pull/552";
    const project = work({
      toReconcile: [{ id: "b5", number: 552, title: "Old fix", status: "ready_to_merge", pullRequestUrl: pr }],
      facts: new Map([["b5", facts({ pullRequestUrl: pr })]]),
    });
    const item = itemsFor(agent("manager", "owner-dana"), project, nothingMine).find((i) => i.kind === "reconcile_merged");
    expect(item).toMatchObject({ key: `reconcile_merged:b5:${pr}`, minimumRole: "manager", canAct: true });
    expect(item!.detail).toContain("Check whether the PR is merged; if so, resolve it");
    expect(item!.actions.map((a) => [a.name, a.path])).toEqual([
      ["resolve_merged", "/api/v1/issues/b5/resolve?projectId=p1"],
      ["repair_pull_request", "/api/v1/issues/b5/pull-request?projectId=p1"],
    ]);
    // A working agent sees it but can't act; a manager whose owner filed it can't either.
    expect(itemsFor(agent("working", "owner-eli"), project, nothingMine).find((i) => i.kind === "reconcile_merged")).toMatchObject({ canAct: false });
    expect(itemsFor(agent("manager", "owner-ada"), project, nothingMine).find((i) => i.kind === "reconcile_merged")).toMatchObject({ canAct: false });
  });

  it("says a link under the old repository name needs repairing, on the issue's items and as a manager item (#triage)", () => {
    const old = "https://github.com/Zedu-Endor/issue-tracker/pull/552";
    const project = work({
      toAccept: [{ id: "b2", number: 552, title: "Old fix" }],
      toRepair: [{ id: "b2", number: 552, title: "Old fix", status: "done", pullRequestUrl: old, linkState: "old_repository" }],
      facts: new Map([["b2", facts({ pullRequestUrl: old })]]),
    });
    const items = itemsFor(agent("manager", "owner-dana"), project, nothingMine);
    const accept = items.find((i) => i.kind === "accept_fix");
    expect(accept!.detail).toContain("PR belongs to the old repository: repair it first.");
    const repair = items.find((i) => i.kind === "repair_pull_request");
    expect(repair).toMatchObject({ key: `repair_pull_request:b2:${old}`, minimumRole: "manager", canAct: true, issue: { id: "b2", number: 552 } });
    expect(repair!.actions.map((a) => [a.name, a.path])).toEqual([["repair_pull_request", "/api/v1/issues/b2/pull-request?projectId=p1"]]);
    // A working agent sees it but can't act; a manager whose owner filed it can't either.
    expect(itemsFor(agent("working", "owner-eli"), project, nothingMine).find((i) => i.kind === "repair_pull_request")).toMatchObject({ canAct: false });
    expect(itemsFor(agent("manager", "owner-ada"), project, nothingMine).find((i) => i.kind === "repair_pull_request")).toMatchObject({ canAct: false });
  });

  it("doesn't add a second repair item when the reconcile item already offers the repair", () => {
    const old = "https://github.com/zeduchat/bug-tracker/pull/9";
    const project = work({
      toReconcile: [{ id: "b5", number: 9, title: "Fix", status: "ready_to_merge", pullRequestUrl: old }],
      toRepair: [{ id: "b5", number: 9, title: "Fix", status: "ready_to_merge", pullRequestUrl: old, linkState: "old_repository" }],
      facts: new Map([["b5", facts({ pullRequestUrl: old })]]),
    });
    const items = itemsFor(agent("manager", "owner-dana"), project, nothingMine);
    expect(items.filter((i) => i.kind === "repair_pull_request")).toHaveLength(0);
    expect(items.find((i) => i.kind === "reconcile_merged")!.detail).toContain("PR belongs to the old repository: repair it first.");
  });

  it("names a link in another repository as one to repair or replace", () => {
    const elsewhere = "https://github.com/someone/fork/pull/3";
    const project = work({
      toRepair: [{ id: "b6", number: 3, title: "Fix", status: "in_progress", pullRequestUrl: elsewhere, linkState: "other_repository" }],
      facts: new Map([["b6", facts({ pullRequestUrl: elsewhere })]]),
    });
    const repair = itemsFor(agent("manager", "owner-dana"), project, nothingMine).find((i) => i.kind === "repair_pull_request");
    expect(repair!.detail).toContain("PR is not in the project's repository");
  });

  it("lists repair_pull_request as waiting for a manager when a working agent can't do it", () => {
    const old = "https://github.com/Zedu-Endor/issue-tracker/pull/552";
    const project = work({
      toRepair: [{ id: "b2", number: 552, title: "Old fix", status: "delivered", pullRequestUrl: old, linkState: "old_repository" }],
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
      { kind: "convert_idea", count: 2, minimumRole: "manager", what: "2 ideas to convert to issues" },
      { kind: "accept_fix", count: 1, minimumRole: "manager", what: "1 tested fix to accept or reject" },
      { kind: "merge_fix", count: 1, minimumRole: "merger", what: "1 accepted fix to merge" },
    ]);
    expect(lines).toEqual([
      "Also open in this project, for a manager agent: 2 ideas to convert to issues and 1 tested fix to accept or reject. You can't do these as a working agent, but they are work waiting to be done.",
      "Also open in this project, for a merger agent: 1 accepted fix to merge. You can't do it as a working agent, but it is work waiting to be done.",
    ]);
  });

  it("tells a manager only about merger work, and a merger about nothing", () => {
    expect(waitingForOthers("manager", itemsFor(agent("manager"), project, nothingMine)).waiting.map((w) => w.kind)).toEqual(["merge_fix"]);
    expect(waitingForOthers("merger", itemsFor(agent("merger"), project, nothingMine))).toEqual({ waiting: [], lines: [] });
  });

  it("lets a manager convert its owner's own idea", () => {
    const own = work({ toConvert: [{ id: "b1", number: 7, title: "x", score: 4 }], facts: new Map([["b1", facts({ reporterId: "owner-bob", beneficiaryUserId: "owner-bob" })]]) });
    const item = itemsFor(agent("manager"), own, nothingMine).find((i) => i.kind === "convert_idea");
    expect(item).toMatchObject({ canAct: true });
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
