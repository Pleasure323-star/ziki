import { describe, expect, it } from "vitest";
import { DEPLOY_STAGES, deployStageOf, isDeployStage, stageReached } from "./deploy-stage";

describe("deployStageOf", () => {
  it("is null until the fix is merged", () => {
    expect(deployStageOf(null)).toBeNull();
    expect(deployStageOf(undefined)).toBeNull();
    expect(deployStageOf("submitted")).toBeNull();
    expect(deployStageOf("ready_to_merge")).toBeNull();
    expect(deployStageOf("rejected")).toBeNull();
  });

  it("treats a merged fix as at least in dev", () => {
    expect(deployStageOf("resolved")).toBe("dev");
  });

  it("prefers a recorded stage over the fallback", () => {
    expect(deployStageOf("resolved", "staging")).toBe("staging");
    expect(deployStageOf("resolved", "main")).toBe("main");
  });

  it("ignores an unknown recorded stage", () => {
    expect(deployStageOf("resolved", "prod")).toBe("dev");
    expect(deployStageOf("submitted", "prod")).toBeNull();
  });
});

describe("stageReached", () => {
  it.each([
    ["dev", "dev", true],
    ["staging", "dev", false],
    ["main", "dev", false],
    ["dev", "staging", true],
    ["staging", "staging", true],
    ["main", "staging", false],
    ["dev", "main", true],
    ["staging", "main", true],
    ["main", "main", true],
  ] as const)("%s reached when furthest is %s → %s", (stage, furthest, expected) => {
    expect(stageReached(stage, furthest)).toBe(expected);
  });
});

describe("isDeployStage", () => {
  it("accepts only the three stages", () => {
    for (const stage of DEPLOY_STAGES) expect(isDeployStage(stage)).toBe(true);
    expect(isDeployStage("prod")).toBe(false);
    expect(isDeployStage(null)).toBe(false);
  });
});
