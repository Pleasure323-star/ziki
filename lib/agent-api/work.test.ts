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
    toConfirm: [],
    ideaThreshold: 3,
    tests: [],
    ready: [],
    toAccept: [],
    toMerge: [],
    jobs: [],
    facts: new Map(),
    ideaFacts: new Map(),
    offerWindowSeconds: 1800,
    ...overrides,
  };
}

const nothingMine: AgentWork = { offers: [], reviewOffers: [], jobReviewOffers: [], claims: [], unread: 0 };

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

  it("tells a manager agent it may give up to 5 votes", () => {
    const items = itemsFor(agent("manager"), work({ ideas: [{ id: "b1", number: 7, title: "x", score: 0 }], ideaFacts: new Map([["b1", ideaFacts()]]) }), nothingMine);
    expect(items[0].actions[0].cli).toContain("--votes 1-5");
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

  it("leaves out fixes the owner already tested at this pull request", () => {
    const pr = "https://github.com/emerjent/ziki/pull/1";
    const tested = facts({ pullRequestUrl: pr, testerOwners: [{ ownerUserId: "owner-bob", pullRequestUrl: pr }] });
    const items = itemsFor(agent("working"), work({ tests: [{ id: "b1", number: 7, title: "x", pullRequestUrl: pr }], facts: new Map([["b1", tested]]) }), nothingMine);
    expect(items).toEqual([]);
  });

  it("lists manager and merger work for a working agent without letting it act", () => {
    const project = work({
      ready: [{ id: "b1", number: 1, title: "x", voteCount: 3, severity: "high" }],
      toAccept: [{ id: "b2", number: 2, title: "y" }],
      toMerge: [{ id: "b3", number: 3, title: "z", reviewStatus: "ready_to_merge" }],
      facts: new Map([["b2", facts()], ["b3", facts()]]),
    });
    const items = itemsFor(agent("working"), project, nothingMine);
    const byKind = Object.fromEntries(items.map((item) => [item.kind, item]));
    expect(byKind.ready_issue).toMatchObject({ canAct: true, minimumRole: "working" });
    expect(byKind.dispatch).toMatchObject({ canAct: false, minimumRole: "manager", blockedReason: "Needs a manager agent." });
    expect(byKind.accept_fix).toMatchObject({ canAct: false, minimumRole: "manager" });
    expect(byKind.merge_fix).toMatchObject({ canAct: false, minimumRole: "merger", blockedReason: "Needs a merger agent." });

    const merger = Object.fromEntries(itemsFor(agent("merger"), project, nothingMine).map((item) => [item.kind, item]));
    expect(merger.dispatch.canAct).toBe(true);
    expect(merger.accept_fix.canAct).toBe(true);
    expect(merger.merge_fix.canAct).toBe(true);
  });

  it("blocks a manager from accepting a fix it is not independent of", () => {
    const own = facts({ reporterId: "owner-dana", beneficiaryUserId: "owner-dana" });
    const items = itemsFor(agent("manager", "owner-dana"), work({ toAccept: [{ id: "b2", number: 2, title: "y" }], facts: new Map([["b2", own]]) }), nothingMine);
    expect(items[0]).toMatchObject({ kind: "accept_fix", canAct: false });
    expect(items[0].blockedReason).toMatch(/Your owner/);
  });

  it("puts offers addressed to the agent first, with their deadline", () => {
    const offeredAt = new Date("2026-10-29T10:00:00Z");
    const mine: AgentWork = {
      ...nothingMine,
      offers: [{ id: "o1", offeredAt, bug: { id: "b9", number: 9, title: "Offered" } }],
    };
    const items = itemsFor(agent("working"), work({ ready: [{ id: "b1", number: 1, title: "x", voteCount: 3, severity: "high" }] }), mine);
    expect(items[0]).toMatchObject({ kind: "offer", key: "offer:o1", dueAt: "2026-10-29T10:30:00.000Z" });
    expect(items[0].actions[0]).toMatchObject({ name: "accept_offer", path: "/api/v1/offers/o1/accept", cli: "accept-offer --id o1" });
  });
});

describe("waitingForOthers", () => {
  const project = work({
    toConvert: [{ id: "b1", number: 7, title: "x", score: 4 }, { id: "b4", number: 9, title: "w", score: 3 }],
    toAccept: [{ id: "b2", number: 2, title: "y" }],
    toMerge: [{ id: "b3", number: 3, title: "z", reviewStatus: "ready_to_merge" }],
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
