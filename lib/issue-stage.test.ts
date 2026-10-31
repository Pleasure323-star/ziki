import { describe, expect, it } from "vitest";
import { confirmersOf, countedConfirmationEntries, isConfirmedCount, issueStage, markedDuplicate, parseIssueStageView, type ConfirmationEntry, weightedTotal } from "./issue-stage";

const bug = { beneficiaryUserId: "beneficiary", reporterId: "reporter", createdByAgent: null, claims: [] };

describe("issueStage", () => {
  it("follows the status: Requires confirmation is confirming, Open is ready (#requires-confirmation)", () => {
    expect(issueStage({ status: "requires_confirmation" })).toBe("confirming");
    expect(issueStage({ status: "open" })).toBe("ready");
  });

  it("has no stage once someone starts the work", () => {
    expect(issueStage({ status: "in_progress" })).toBeNull();
    expect(issueStage({ status: "resolved" })).toBeNull();
  });
});

const at = (minute: number) => new Date(Date.UTC(2026, 11, 4, 10, minute));
const entry = (id: string, overrides: Partial<ConfirmationEntry> = {}): ConfirmationEntry => ({
  id,
  verdict: "confirm",
  duplicateOfId: null,
  updatedAt: at(1),
  undoneAt: null,
  agentId: `agent-${id}`,
  agentOwnerUserId: `owner-${id}`,
  onBehalfOfUserId: `owner-${id}`,
  ...overrides,
});
const reviewed = { ...bug, createdByAgentId: "filer" };

describe("countedConfirmationEntries (#issue-confirmations)", () => {
  it("counts an entry on the person's own issue, at weight 1 whatever its class (#confirmation-weights)", () => {
    const counted = countedConfirmationEntries(
      [entry("v1", { agentOwnerUserId: "reporter", onBehalfOfUserId: "reporter", weightClass: "manager" }), entry("v2")],
      reviewed,
      null,
    );
    expect(counted.map((e) => [e.id, e.weight])).toEqual([["v1", 1], ["v2", 1]]);
  });

  it("weighs a manager agent's confirm managerVoteWeight and a worker's or a person's 1, confirming at 3", () => {
    const manager = countedConfirmationEntries([entry("m1", { weightClass: "manager" })], reviewed, null, 3);
    expect(weightedTotal(manager, "confirm")).toBe(3);
    expect(isConfirmedCount(weightedTotal(manager, "confirm"), 3)).toBe(true);
    const workers = countedConfirmationEntries(
      [entry("v1"), entry("person", { agentId: null, agentOwnerUserId: null, onBehalfOfUserId: "pat", updatedAt: at(2) })],
      reviewed,
      null,
      3,
    );
    expect(weightedTotal(workers, "confirm")).toBe(2);
    expect(isConfirmedCount(weightedTotal(workers, "confirm"), 3)).toBe(false);
  });

  it("lets one person count twice, once per class, but not twice in one class", () => {
    const counted = countedConfirmationEntries(
      [
        entry("w1", { agentOwnerUserId: "one", onBehalfOfUserId: "one" }),
        entry("w2", { agentOwnerUserId: "one", onBehalfOfUserId: "one", updatedAt: at(2) }),
        entry("m1", { agentOwnerUserId: "one", onBehalfOfUserId: "one", weightClass: "manager", updatedAt: at(3) }),
      ],
      reviewed,
      null,
      3,
    );
    expect(counted.map((e) => e.id)).toEqual(["w1", "m1"]);
    expect(weightedTotal(counted, "confirm")).toBe(4);
    expect(confirmersOf(counted)).toEqual(["one"]);
  });

  it("does not count an undone entry or one given before the edit", () => {
    const counted = countedConfirmationEntries(
      [entry("v1"), entry("gone", { undoneAt: at(2) }), entry("stale", { updatedAt: at(0) })],
      reviewed,
      at(0),
    );
    expect(counted.map((e) => e.id)).toEqual(["v1"]);
  });

  it("counts rejects apart from confirms; neutral is passed over by the caller's query, and a duplicate reject marks it", () => {
    const counted = countedConfirmationEntries([entry("c1"), entry("r1", { verdict: "reject", duplicateOfId: "other" })], reviewed, null);
    expect(confirmersOf(counted)).toEqual(["owner-c1"]);
    expect(markedDuplicate(counted)).toBe(true);
    expect(markedDuplicate(countedConfirmationEntries([entry("r2", { verdict: "reject" })], reviewed, null))).toBe(false);
  });
});

describe("parseIssueStageView", () => {
  it("takes the issue stage names only: ideas are not issues and have no stage (#idea-table)", () => {
    expect(parseIssueStageView("confirming")).toBe("confirming");
    expect(parseIssueStageView("ready")).toBe("ready");
    expect(parseIssueStageView("idea")).toBeNull();
    expect(parseIssueStageView("reported")).toBeNull();
    expect(parseIssueStageView("confirmed")).toBeNull();
    expect(parseIssueStageView("queued")).toBeNull();
    expect(parseIssueStageView(undefined)).toBeNull();
  });
});
