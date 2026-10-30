import { describe, expect, it } from "vitest";
import {
  parseProjectRewardConfig,
  calculateSolverPoints,
  calculateReporterPoints,
  calculateReviewerPoints,
} from "./project-rewards";
import { SOLVER_POINTS, REPORTER_POINTS, REVIEWER_POINTS } from "./rules";

describe("project-rewards", () => {
  it("uses default point values when config is empty or invalid", () => {
    const config = parseProjectRewardConfig(null);
    expect(config.solver).toBe(SOLVER_POINTS);
    expect(config.reporter).toBe(REPORTER_POINTS);
    expect(config.reviewer).toBe(REVIEWER_POINTS);
    expect(config.guidelines).toBeNull();

    expect(calculateSolverPoints(config)).toBe(SOLVER_POINTS);
    expect(calculateSolverPoints()).toBe(SOLVER_POINTS);
    expect(calculateReporterPoints(config)).toBe(REPORTER_POINTS);
    expect(calculateReviewerPoints(config)).toBe(REVIEWER_POINTS);
  });

  it("parses valid custom reward configs and computes points accordingly", () => {
    const raw = {
      solver: 40,
      reporter: 5,
      reviewer: 8,
      guidelines: "Bonus points for high quality repro steps",
    };

    const config = parseProjectRewardConfig(raw);
    expect(config.solver).toBe(40);
    expect(config.reporter).toBe(5);
    expect(config.reviewer).toBe(8);
    expect(config.guidelines).toBe("Bonus points for high quality repro steps");

    expect(calculateSolverPoints(config)).toBe(40);
    expect(calculateReporterPoints(config)).toBe(5);
    expect(calculateReviewerPoints(config)).toBe(8);
  });

  it("rejects the old per-severity solver table and keeps the defaults", () => {
    const config = parseProjectRewardConfig({ solver: { low: 10, medium: 20, high: 30, critical: 40 } });
    expect(config.solver).toBe(SOLVER_POINTS);
  });
});
