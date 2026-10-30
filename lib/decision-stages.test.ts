import { describe, expect, it } from "vitest";
import { statuses } from "@/lib/validations/issue";
import {
  DECISION_STAGES,
  claimDecisionKind,
  currentDecisionStage,
  payloadMerged,
  pipelineStages,
  stageSetback,
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
    [{ kind: "claimed" }, "progress", "positive"],
    [{ kind: "claim_released" }, "progress", "negative"],
    [{ kind: "delivered" }, "progress", "positive"],
    [{ kind: "verdict", goodToMerge: true }, "delivered", "positive"],
    [{ kind: "verdict", goodToMerge: false }, "delivered", "negative"],
    [{ kind: "accepted" }, "done", "positive"],
    [{ kind: "merge_rejected" }, "done", "negative"],
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
      open: { positive: 0, negative: 0 },
      progress: { positive: 1, negative: 1 },
      delivered: { positive: 7, negative: 2 },
      done: { positive: 0, negative: 0 },
      ready: { positive: 0, negative: 0 },
      live: { positive: 0, negative: 0 },
      closed: { positive: 0, negative: 0 },
    });
  });
});

describe("currentDecisionStage", () => {
  it("is the issue's one status: every status has its own step", () => {
    expect(currentDecisionStage({ status: "requires_confirmation" })).toBe("confirm");
    expect(currentDecisionStage({ status: "open" })).toBe("open");
    expect(currentDecisionStage({ status: "in_progress" })).toBe("progress");
    expect(currentDecisionStage({ status: "delivered" })).toBe("delivered");
    expect(currentDecisionStage({ status: "done" })).toBe("done");
    expect(currentDecisionStage({ status: "ready_to_merge" })).toBe("ready");
    expect(currentDecisionStage({ status: "resolved" })).toBe("live");
    expect(currentDecisionStage({ status: "closed" })).toBe("closed");
  });
  it("puts every status on the pipeline, with Closed in Live's place", () => {
    for (const status of statuses) expect(pipelineStages(currentDecisionStage({ status }))).toContain(currentDecisionStage({ status }));
    expect(pipelineStages("closed")).toEqual(["idea", "confirm", "open", "progress", "delivered", "done", "ready", "closed"]);
    // Before Done the pipeline ends at Done; from Done on it runs to Live.
    expect(pipelineStages("open")).toEqual(["idea", "confirm", "open", "progress", "delivered", "done"]);
    expect(pipelineStages("delivered")).toEqual(["idea", "confirm", "open", "progress", "delivered", "done"]);
    expect(pipelineStages("done")).toEqual(DECISION_STAGES);
    expect(pipelineStages("live")).toEqual(DECISION_STAGES);
  });
  it("is a setback only when a manager sent the fix back to In progress", () => {
    expect(stageSetback("progress", true)).toBe(true);
    expect(stageSetback("progress", false)).toBe(false);
    expect(stageSetback("done", true)).toBe(false);
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
      open: null,
      progress: Date.parse("2026-10-22T16:00:00.000Z"),
      delivered: Date.parse("2026-10-22T20:00:00.000Z"),
      done: Date.parse("2026-10-25T09:40:00.000Z"),
      ready: null,
      live: null,
      closed: null,
    });
  });
  it("finds the stage the issue was in at a time", () => {
    expect(stageAt("2026-10-21T20:00:00.000Z", starts)).toBe("idea");
    expect(stageAt("2026-10-21T22:00:00.000Z", starts)).toBe("confirm");
    expect(stageAt("2026-10-22T16:00:00.000Z", starts)).toBe("progress");
    expect(stageAt("2026-10-24T00:00:00.000Z", starts)).toBe("delivered");
    expect(stageAt("2026-10-26T00:00:00.000Z", starts)).toBe("done");
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
