import { describe, expect, it } from "vitest";
import { confirmersOf, countedConfirmationEntries, isConfirmedCount, issueStage, markedDuplicate, parseIssueStageView, type ConfirmationEntry } from "./issue-stage";

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
  it("excludes legacy entries credited to the reporter", () => {
    const counted = countedConfirmationEntries([entry("v1", { onBehalfOfUserId: "reporter" }), entry("v2")], reviewed, null);
    expect(confirmersOf(counted)).toEqual(["owner-v2"]);
  });

  it("confirms on two independent owners, people and agents alike", () => {
    const counted = countedConfirmationEntries(
      [entry("v1"), entry("person", { agentId: null, agentOwnerUserId: null, onBehalfOfUserId: "pat", updatedAt: at(2) })],
      reviewed,
      null,
    );
    expect(confirmersOf(counted)).toEqual(["owner-v1", "pat"]);
    expect(isConfirmedCount(confirmersOf(counted).length)).toBe(true);
  });

  it("does not count a second agent of one owner, the filer, an undone entry, the reporter as a person, or one before the edit", () => {
    const counted = countedConfirmationEntries(
      [
        entry("v1", { agentOwnerUserId: "one", onBehalfOfUserId: "one" }),
        entry("v2", { agentOwnerUserId: "one", onBehalfOfUserId: "one-too" }),
        entry("own", { agentId: "filer" }),
        entry("gone", { undoneAt: at(2) }),
        entry("self", { agentId: null, agentOwnerUserId: null, onBehalfOfUserId: "reporter" }),
        entry("stale", { updatedAt: at(0) }),
      ],
      reviewed,
      at(0),
    );
    expect(counted.map((e) => e.id)).toEqual(["v1"]);
    expect(isConfirmedCount(confirmersOf(counted).length)).toBe(false);
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
