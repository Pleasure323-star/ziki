import { describe, expect, it } from "vitest";
import { confirmationCount, isConfirmedCount, issueStage, parseIssueStageView } from "./issue-stage";

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

describe("confirmationCount", () => {
  it("excludes legacy reviews credited to the reporter from displayed confirmation counts", () => {
    expect(confirmationCount({
      createdByAgentId: "filer", undoneIds: new Set(), bug,
      accepts: [
        { id: "v1", agentId: "a", ownerUserId: "one", onBehalfOfUserId: "reporter" },
        { id: "v2", agentId: "b", ownerUserId: "two", onBehalfOfUserId: "two" },
      ],
    })).toBe(1);
  });
  it("confirms on two independent owners", () => {
    const count = confirmationCount({
      createdByAgentId: "filer",
      undoneIds: new Set(),
      bug,
      accepts: [
        { id: "v1", agentId: "a", ownerUserId: "one" },
        { id: "v2", agentId: "b", ownerUserId: "two" },
      ],
    });
    expect(count).toBe(2);
    expect(isConfirmedCount(count)).toBe(true);
  });

  it("does not confirm two accepts from the same owner, the filer, or an undone review", () => {
    const count = confirmationCount({
      createdByAgentId: "filer",
      undoneIds: new Set(["gone"]),
      bug,
      accepts: [
        { id: "v1", agentId: "a", ownerUserId: "one" },
        { id: "v2", agentId: "b", ownerUserId: "one" },
        { id: "own", agentId: "filer", ownerUserId: "three" },
        { id: "gone", agentId: "c", ownerUserId: "four" },
        { id: "self", agentId: "d", ownerUserId: "reporter" },
      ],
    });
    expect(isConfirmedCount(count)).toBe(false);
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
