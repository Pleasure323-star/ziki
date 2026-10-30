import { describe, expect, it } from "vitest";
import { countedMergeVerdicts, deliveredClaim, type CountableVerdict } from "./merge-verdicts";

const reviewed = { reporterId: "ada", beneficiaryUserId: "ada", createdByAgentId: null, claims: [] };
const verdict = (owner: string, headSha: string | null = null, agentId = `agent-${owner}`): CountableVerdict => ({
  headSha,
  onBehalfOfUserId: owner,
  agent: { id: agentId, ownerUserId: owner },
});

describe("countedMergeVerdicts: one verdict rule for the merge gate and the merge queue", () => {
  it("counts one verdict per independent owner and names the last counted commit", () => {
    const { reviewers, acceptedHeadSha } = countedMergeVerdicts(
      [verdict("bob", "sha-1"), verdict("bob", "sha-2", "agent-bob-2"), verdict("cara", "sha-3")],
      null,
      reviewed,
      "linked-sha",
    );
    expect(reviewers).toEqual(["bob", "cara"]);
    expect(acceptedHeadSha).toBe("sha-3");
  });

  it("skips the claim holder's agent and owner", () => {
    const claim = { agentId: "agent-dan", agent: { ownerUserId: "dan" } };
    const { reviewers } = countedMergeVerdicts([verdict("dan"), verdict("dan", null, "agent-dan-2"), verdict("bob")], claim, reviewed);
    expect(reviewers).toEqual(["bob"]);
  });

  it("skips reviewers the independence rules exclude, such as the reporter", () => {
    const { reviewers, acceptedHeadSha } = countedMergeVerdicts([verdict("ada", "sha-x"), verdict("bob")], null, reviewed, "linked-sha");
    expect(reviewers).toEqual(["bob"]);
    expect(acceptedHeadSha).toBe("linked-sha");
  });
});

describe("deliveredClaim: the claim a fix was delivered under (#one-status)", () => {
  const at = (iso: string) => new Date(iso);
  const active = { id: "c-active", status: "active", claimedAt: at("2026-10-01T00:00:00Z"), releasedAt: null };
  const early = { id: "c-early", status: "released", claimedAt: at("2026-09-01T00:00:00Z"), releasedAt: at("2026-09-02T00:00:00Z") };
  const late = { id: "c-late", status: "released", claimedAt: at("2026-09-03T00:00:00Z"), releasedAt: at("2026-09-04T00:00:00Z") };
  const declined = { id: "c-declined", status: "released", claimedAt: null, releasedAt: at("2026-09-05T00:00:00Z") };
  const pr = "https://github.com/o/r/pull/1";

  it("is the active claim when there is one", () => {
    expect(deliveredClaim({ pullRequestUrl: pr, claims: [late, active] })?.id).toBe("c-active");
  });
  it("is the last claim let go once a fix is linked, never a declined offer", () => {
    expect(deliveredClaim({ pullRequestUrl: pr, claims: [early, declined, late] })?.id).toBe("c-late");
  });
  it("is none without a linked fix or an active claim", () => {
    expect(deliveredClaim({ pullRequestUrl: null, claims: [early, late] })).toBeNull();
  });
});
