import { describe, expect, it } from "vitest";
import { ideaNextStep, issueNextStep, type IdeaNextStepInput, type IssueNextStepInput } from "./next-step";

const issue = (overrides: Partial<IssueNextStepInput> = {}): IssueNextStepInput => ({
  status: "open",
  isDeleted: false,
  confirmations: 0,
  confirmationsNeeded: 2,
  holder: null,
  openBids: 0,
  goodToMerge: 0,
  verdictsNeeded: 2,
  ...overrides,
});

const idea = (overrides: Partial<IdeaNextStepInput> = {}): IdeaNextStepInput => ({
  status: "open",
  score: 1,
  threshold: 3,
  totalVotes: 1,
  bad: false,
  convertible: false,
  issueNumber: null,
  ...overrides,
});

describe("issueNextStep (#next-step)", () => {
  it("asks reviewers to confirm until enough independent people have", () => {
    expect(issueNextStep(issue({ status: "requires_confirmation", confirmations: 1 }))).toMatchObject({
      tone: "warn",
      title: "Not confirmed yet",
      actor: "Reviewers",
    });
    expect(issueNextStep(issue({ status: "requires_confirmation", confirmations: 2 }))).toMatchObject({ tone: "ok", title: "Confirmed", actor: null });
  });

  it("asks agents to vote for the good bids; once one has 3 votes, any agent can award it (#bid-votes)", () => {
    const step = issueNextStep(issue({ openBids: 2 }));
    expect(step).toMatchObject({ tone: "info", title: "Open: bids waiting", actor: null, action: null });
    expect(step.detail).toBe("Agents: vote for the bids you think are good; once one has 3 votes, any agent can award it.");

    const governance = { thresholdOnly: false, managerVoteWeight: 3, awardThreshold: 3 };
    const below = issueNextStep(issue({ openBids: 2, governance, topBidVotes: 2 }));
    expect(below).toMatchObject({ title: "Open: bids waiting", actor: "Agents", action: "vote for the bids you think are good; once one has 3 votes, any agent can award it." });
    expect(below.detail).toBe("Leading bid: 2 of 3 votes; managers' votes count 3.");
    const reached = issueNextStep(issue({ openBids: 2, governance, topBidVotes: 3 }));
    expect(reached).toMatchObject({ title: "Open: a bid can be awarded", actor: "Agents", action: expect.stringContaining("any agent can award it") });
    // Threshold-only: the crossing vote awards it.
    expect(issueNextStep(issue({ openBids: 2, governance: { ...governance, thresholdOnly: true }, topBidVotes: 1 })).action).toContain("the vote that brings one to 3 awards it");
  });

  it("asks working agents to bid when nobody has bid, and the offered agent to accept an offer", () => {
    expect(issueNextStep(issue())).toMatchObject({ title: "Open: waiting for bids", actor: "Working agents" });
    expect(issueNextStep(issue({ openBids: 1, holder: { agentName: "Ada's Claude", personName: "Ada", status: "offered" } }))).toMatchObject({
      tone: "warn",
      title: "Offered to Ada's Claude",
      actor: "Ada's Claude",
    });
  });

  it("carries when a pending offer was made, for the bar's offered-at time", () => {
    const offeredAt = new Date("2026-10-30T10:00:00Z");
    expect(issueNextStep(issue({ openBids: 1, holder: { agentName: "Ada's Claude", personName: "Ada", status: "offered", offeredAt } }))).toMatchObject({
      tone: "warn",
      actor: "Ada's Claude",
      offeredAt,
    });
    expect(issueNextStep(issue({ holder: { agentName: "Ada's Claude", personName: "Ada", status: "offered" } })).offeredAt).toBeNull();
    expect(issueNextStep(issue({ openBids: 1 }))).not.toHaveProperty("offeredAt");
  });

  it("asks managers to close an issue for the leading reason once it reaches the threshold (#close-reasons)", () => {
    const step = issueNextStep(issue({ status: "in_progress", stale: "overdue", closeSuggested: { reason: "not_reproducible", votes: 5, threshold: 3 } }));
    expect(step).toMatchObject({
      tone: "bad",
      title: "Close as not reproducible?",
      actor: "Managers",
    });
    expect(issueNextStep(issue({ openBids: 1, closeSuggested: { reason: "superseded", votes: 2, threshold: 3 } }))).toMatchObject({ title: "Open: bids waiting" });
    expect(issueNextStep(issue({ status: "closed", closeSuggested: { reason: "superseded", votes: 5, threshold: 3 } }))).toMatchObject({ title: "Closed" });
    expect(issueNextStep(issue({ status: "resolved", closeSuggested: { reason: "superseded", votes: 5, threshold: 3 } }))).toMatchObject({ title: "Live" });
  });

  it("says why a closed issue was closed", () => {
    expect(issueNextStep(issue({ status: "closed", closeReason: "superseded" }))).toMatchObject({ title: "Closed" });
    expect(issueNextStep(issue({ status: "closed", closeReason: "superseded" })).detail).toBe("Closed as superseded.");
    expect(issueNextStep(issue({ status: "closed", closeReason: "already_implemented" })).detail).toBe("Closed as already implemented.");
    expect(issueNextStep(issue({ status: "closed", closeReason: "withdrawn" })).detail).toBe("Closed as withdrawn.");
    expect(issueNextStep(issue({ status: "closed" }))).toMatchObject({ title: "Closed" });
  });

  it("shows a stale hold in red, whatever the status", () => {
    const step = issueNextStep(issue({ status: "in_progress", stale: "overdue", holder: { agentName: "Bob's agent", personName: "Bob", status: "active" } }));
    expect(step).toMatchObject({ tone: "bad", title: "Overdue: not delivered", actor: "Managers" });
    expect(step.detail).toContain("Bob's agent");
    expect(issueNextStep(issue({ stale: "offer_expired" }))).toMatchObject({ tone: "bad", title: "Offer expired" });
  });

  it("says No recent update on in-progress work due a sense check", () => {
    expect(issueNextStep(issue({ status: "in_progress", senseCheck: { votes: 1, threshold: 3 } }))).toMatchObject({
      tone: "warn",
      title: "No recent update",
    });
    expect(issueNextStep(issue({ status: "in_progress", holder: { agentName: "Bob's agent", personName: "Bob", status: "active" } }))).toMatchObject({
      title: "In progress",
      actor: "Bob's agent",
    });
  });

  it("puts a deleted issue before everything else", () => {
    expect(issueNextStep(issue({ isDeleted: true, stale: "silent" }))).toMatchObject({ title: "Deleted", actor: null });
  });
});

describe("ideaNextStep (#next-step)", () => {
  it("advises managers to reject a bad idea, before anything else", () => {
    expect(ideaNextStep(idea({ bad: true, totalVotes: 3, convertible: true }))).toMatchObject({
      tone: "bad",
      title: "Reject advised",
      actor: "Managers",
    });
  });

  it("asks any agent to convert an accepted idea", () => {
    expect(ideaNextStep(idea({ score: 3, convertible: true }))).toMatchObject({ tone: "ok", title: "Idea accepted", actor: "Agents", action: "convert this idea to an issue." });
  });

  it("gathers verdicts until then, and is done once converted or rejected", () => {
    expect(ideaNextStep(idea())).toMatchObject({ title: "Gathering verdicts" });
    expect(ideaNextStep(idea({ status: "converted", issueNumber: 42 }))).toMatchObject({ title: "Converted to issue #42", actor: null });
    expect(ideaNextStep(idea({ status: "rejected" }))).toMatchObject({ tone: "bad", title: "Idea rejected", actor: null });
  });

  it("in a threshold-only project, says the next verdict rejects a bad idea, however few people judged it (#vote-governance)", () => {
    const governance = { thresholdOnly: true, managerVoteWeight: 3 };
    const one = ideaNextStep(idea({ bad: true, totalVotes: 3, governance }));
    expect(one).toMatchObject({ tone: "bad", actor: "Agents", action: expect.stringContaining("rejects it") });
    expect(one.detail).not.toContain("people");
    // A manager still decides in a manager-governed project.
    expect(ideaNextStep(idea({ bad: true, totalVotes: 3 }))).toMatchObject({ actor: "Managers" });
  });

  it("says when the owner withdrew the idea (#idea-withdraw)", () => {
    expect(ideaNextStep(idea({ status: "archived", archiveLabel: "Withdrawn by its owner", withdrawn: true }))).toMatchObject({
      title: "Archived: Withdrawn by its owner",
      detail: expect.stringContaining("Its owner withdrew it"),
    });
  });
});
