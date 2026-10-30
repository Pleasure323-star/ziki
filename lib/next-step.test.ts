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
    expect(issueNextStep(issue({ status: "requires_confirmation", confirmations: 1 }))).toEqual({
      tone: "warn",
      title: "Not confirmed yet",
      detail: "1 of 2 confirmations from independent people.",
      actor: "Reviewers",
      action: "please confirm or reject this issue with a confirmation entry.",
    });
    expect(issueNextStep(issue({ status: "requires_confirmation", confirmations: 2 }))).toMatchObject({ tone: "ok", title: "Confirmed", actor: null });
  });

  it("asks managers to award one of the open bids, and agents to vote for the good ones", () => {
    expect(issueNextStep(issue({ openBids: 2 }))).toEqual({
      tone: "info",
      title: "Open: bids waiting",
      detail: "Agents: vote for the bids you think are good.",
      actor: "Managers",
      action: "award one of the bids.",
    });
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
    expect(issueNextStep(issue({ openBids: 1, holder: { agentName: "Ada's Claude", personName: "Ada", status: "offered", offeredAt } }))).toEqual({
      tone: "warn",
      title: "Offered to Ada's Claude",
      detail: "For Ada; waiting for it to accept.",
      actor: "Ada's Claude",
      action: "please accept or decline the offer.",
      offeredAt,
    });
    expect(issueNextStep(issue({ holder: { agentName: "Ada's Claude", personName: "Ada", status: "offered" } })).offeredAt).toBeNull();
    expect(issueNextStep(issue({ openBids: 1 }))).not.toHaveProperty("offeredAt");
  });

  it("asks managers to close an issue as superseded once its suggestions reach the threshold (#close-superseded)", () => {
    const step = issueNextStep(issue({ status: "in_progress", stale: "overdue", closeSuggested: { votes: 5, threshold: 3 } }));
    expect(step).toEqual({
      tone: "bad",
      title: "Close as superseded?",
      detail: "5 of 3 votes to close it: agents say another issue or change covers it.",
      actor: "Managers",
      action: "close it as superseded if the suggestions hold up.",
    });
    expect(issueNextStep(issue({ openBids: 1, closeSuggested: { votes: 2, threshold: 3 } }))).toMatchObject({ title: "Open: bids waiting" });
    expect(issueNextStep(issue({ status: "closed", closeSuggested: { votes: 5, threshold: 3 } }))).toMatchObject({ title: "Closed" });
    expect(issueNextStep(issue({ status: "resolved", closeSuggested: { votes: 5, threshold: 3 } }))).toMatchObject({ title: "Live" });
  });

  it("says why a closed issue was closed", () => {
    expect(issueNextStep(issue({ status: "closed", closeReason: "superseded" }))).toMatchObject({ title: "Closed", detail: "Closed as superseded." });
    expect(issueNextStep(issue({ status: "closed" }))).toMatchObject({ title: "Closed", detail: "Stopped without shipping." });
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
      detail: "1 of 3 Abandoned votes so far; a manager agent's vote counts 3.",
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
      detail: "More bad and neutral votes than good ones (3 votes).",
      actor: "Managers",
    });
  });

  it("asks managers to convert an accepted idea", () => {
    expect(ideaNextStep(idea({ score: 3, convertible: true }))).toMatchObject({ tone: "ok", title: "Idea accepted", action: "please convert this idea to an issue." });
  });

  it("gathers verdicts until then, and is done once converted or rejected", () => {
    expect(ideaNextStep(idea())).toMatchObject({ title: "Gathering verdicts", detail: "Score 1 of 3 needed · 1 vote so far." });
    expect(ideaNextStep(idea({ status: "converted", issueNumber: 42 }))).toMatchObject({ title: "Converted to issue #42", actor: null });
    expect(ideaNextStep(idea({ status: "rejected" }))).toMatchObject({ tone: "bad", title: "Idea rejected", actor: null });
  });
});
