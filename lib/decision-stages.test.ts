import { describe, expect, it } from "vitest";
import {
  claimDecisionKind,
  currentDecisionStage,
  payloadMerged,
  decisionTone,
  stageAt,
  stageOfDecision,
  stageStarts,
  tallyStages,
  type DecisionLike,
} from "./decision-stages";

describe("stageOfDecision and decisionTone (#1446)", () => {
  const cases: [DecisionLike, string, string][] = [
    [{ kind: "confirmed" }, "confirm", "positive"],
    [{ kind: "rejected" }, "confirm", "negative"],
    [{ kind: "claimed" }, "open", "positive"],
    [{ kind: "claim_released" }, "open", "negative"],
    [{ kind: "verdict", goodToMerge: true }, "done", "positive"],
    [{ kind: "verdict", goodToMerge: false }, "done", "negative"],
    [{ kind: "accepted" }, "ready", "positive"],
    [{ kind: "merge_rejected" }, "ready", "negative"],
    [{ kind: "deploy_failed" }, "ready", "negative"],
    [{ kind: "accepted", merged: true }, "live", "positive"],
  ];

  it.each(cases)("%o is %s and %s", (decision, stage, tone) => {
    expect(stageOfDecision(decision)).toBe(stage);
    expect(decisionTone(decision)).toBe(tone);
  });
});

describe("claimDecisionKind", () => {
  const claimedAt = "2026-10-22T16:00:00.000Z";

  it("skips offers nobody took up", () => {
    expect(claimDecisionKind({ status: "offered", claimedAt: null, releaseReason: null })).toBeNull();
    expect(claimDecisionKind({ status: "released", claimedAt: null, releaseReason: "expired" })).toBeNull();
  });
  it("counts active claims and claims released by the fix landing as positive", () => {
    expect(claimDecisionKind({ status: "active", claimedAt, releaseReason: null })).toBe("claimed");
    expect(claimDecisionKind({ status: "released", claimedAt, releaseReason: "resolved" })).toBe("claimed");
  });
  it("counts any other release as a rejected claim", () => {
    expect(claimDecisionKind({ status: "released", claimedAt, releaseReason: "deadline" })).toBe("claim_released");
    expect(claimDecisionKind({ status: "released", claimedAt, releaseReason: "revoked" })).toBe("claim_released");
  });
});

describe("payloadMerged", () => {
  it("is true only for an explicit merged: true", () => {
    expect(payloadMerged({ merged: true })).toBe(true);
    expect(payloadMerged({ merged: "true" })).toBe(false);
    expect(payloadMerged(null)).toBe(false);
  });
});

describe("tallyStages", () => {
  it("counts positives and negatives per stage, honouring grouped counts", () => {
    const tallies = tallyStages([
      { kind: "confirmed", count: 8 },
      { kind: "rejected" },
      { kind: "claimed" },
      { kind: "claim_released" },
      { kind: "verdict", goodToMerge: true, count: 7 },
      { kind: "verdict", goodToMerge: false, count: 2 },
    ]);
    expect(tallies).toEqual({
      idea: { positive: 0, negative: 0 },
      confirm: { positive: 8, negative: 1 },
      open: { positive: 1, negative: 1 },
      done: { positive: 7, negative: 2 },
      ready: { positive: 0, negative: 0 },
      live: { positive: 0, negative: 0 },
    });
  });
});

describe("currentDecisionStage", () => {
  const base = { status: "requires_confirmation", reviewStatus: null, pullRequestUrl: null, hasClaim: false, ideaAccepted: false };
  const working = { ...base, status: "in_progress" };
  const pr = "https://github.com/o/r/pull/1";

  it("follows the status: Requires confirmation, then Open", () => {
    expect(currentDecisionStage(base)).toBe("confirm");
    expect(currentDecisionStage({ ...base, status: "open" })).toBe("open");
    expect(currentDecisionStage(working)).toBe("open");
  });
  it("never moves an issue that requires confirmation or is open, whatever its pull request or review says (#685)", () => {
    expect(currentDecisionStage({ ...base, pullRequestUrl: pr, reviewStatus: "submitted" })).toBe("confirm");
    expect(currentDecisionStage({ ...base, reviewStatus: "ready_to_merge" })).toBe("confirm");
    expect(currentDecisionStage({ ...base, status: "open", pullRequestUrl: pr, reviewStatus: "rejected" })).toBe("open");
  });
  it("is Done once an issue in progress has a pull request, including after a merger rejection", () => {
    expect(currentDecisionStage({ ...working, pullRequestUrl: pr })).toBe("done");
    expect(currentDecisionStage({ ...working, reviewStatus: "submitted" })).toBe("done");
    expect(currentDecisionStage({ ...working, reviewStatus: "rejected" })).toBe("done");
  });
  it("is Ready to merge, then Live", () => {
    expect(currentDecisionStage({ ...working, reviewStatus: "ready_to_merge" })).toBe("ready");
    expect(currentDecisionStage({ ...working, reviewStatus: "merge_failed" })).toBe("ready");
    expect(currentDecisionStage({ ...base, status: "resolved", reviewStatus: "merged" })).toBe("live");
    expect(currentDecisionStage({ ...base, status: "resolved" })).toBe("live");
  });
});

describe("stageStarts and stageAt", () => {
  const starts = stageStarts([
    { kind: "confirmed", at: "2026-10-21T21:00:00.000Z" },
    { kind: "claimed", at: "2026-10-22T16:00:00.000Z" },
    { kind: "verdict", goodToMerge: true, at: "2026-10-23T10:00:00.000Z" },
    { kind: "verdict", goodToMerge: false, at: "2026-10-22T20:00:00.000Z" },
    { kind: "accepted", at: "2026-10-25T09:40:00.000Z" },
  ]);

  it("starts each stage at its earliest decision and leaves unreached ones null", () => {
    expect(starts).toEqual({
      confirm: Date.parse("2026-10-21T21:00:00.000Z"),
      open: Date.parse("2026-10-22T16:00:00.000Z"),
      done: Date.parse("2026-10-22T20:00:00.000Z"),
      ready: Date.parse("2026-10-25T09:40:00.000Z"),
      live: null,
    });
  });
  it("finds the stage the issue was in at a time", () => {
    expect(stageAt("2026-10-21T20:00:00.000Z", starts)).toBe("idea");
    expect(stageAt("2026-10-21T22:00:00.000Z", starts)).toBe("confirm");
    expect(stageAt("2026-10-22T16:00:00.000Z", starts)).toBe("open");
    expect(stageAt("2026-10-24T00:00:00.000Z", starts)).toBe("done");
    expect(stageAt("2026-10-26T00:00:00.000Z", starts)).toBe("ready");
  });
});

describe("stageStarts with a conversion time", () => {
  it("starts Requires confirmation when the idea is converted (#714)", () => {
    const converted = stageStarts([{ kind: "claimed", at: "2026-10-22T16:00:00.000Z" }], "2026-10-21T12:00:00.000Z");
    expect(converted.confirm).toBe(Date.parse("2026-10-21T12:00:00.000Z"));
    expect(stageAt("2026-10-21T10:00:00.000Z", converted)).toBe("idea");
    expect(stageAt("2026-10-21T13:00:00.000Z", converted)).toBe("confirm");
  });
});
