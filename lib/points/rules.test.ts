import { describe, expect, it } from "vitest";
import {
  confirmationReviewerSourceKey,
  CONFIRMATION_REVIEWER_POINTS,
  diminishedReviewerPoints,
  DUPLICATE_MARKER_POINTS,
  formatPoints,
  MIN_POINT_AWARD,
  TRIAGER_CLEAR_POINTS,
  pointSourceKey,
  pointsNumber,
  pointsProgress,
  REPORTER_POINTS,
  REVIEWER_POINTS,
  reviewerPointsAt,
  SOLVER_POINTS,
  TARGET_POINTS,
} from "./rules";

describe("point rules (#428)", () => {
  it("awards one flat solver amount for every issue", () => {
    expect(SOLVER_POINTS).toBe(750);
  });

  it("has the reporter, reviewer and target numbers from the epic", () => {
    expect(REPORTER_POINTS).toBe(150);
    expect(REVIEWER_POINTS).toBe(300);
    expect(CONFIRMATION_REVIEWER_POINTS).toBe(90);
    expect(TRIAGER_CLEAR_POINTS).toBe(30);
    expect(DUPLICATE_MARKER_POINTS).toBe(150);
    expect(TARGET_POINTS).toBe(500);
  });

  it("pays every later reviewer a little less, and never stops paying", () => {
    expect([0, 1, 2, 3, 4, 5].map((index) => reviewerPointsAt(index, 5))).toEqual([
      5, 4.5, 4.05, 3.65, 3.29, 2.96,
    ]);
    expect(reviewerPointsAt(1, 5)).toBe(diminishedReviewerPoints(5));
    expect([0, 1, 2, 3, 4, 5].map((index) => reviewerPointsAt(index, 10))).toEqual([
      10, 9, 8.1, 7.29, 6.56, 5.9,
    ]);
    expect([0, 1, 2, 3].map((index) => reviewerPointsAt(index, CONFIRMATION_REVIEWER_POINTS))).toEqual([
      90, 81, 72.9, 65.61,
    ]);
    expect(diminishedReviewerPoints(1)).toBe(0.9);
    expect(diminishedReviewerPoints(0.05)).toBe(0.04);
    expect(diminishedReviewerPoints(MIN_POINT_AWARD)).toBe(MIN_POINT_AWARD);

    const tail = Array.from({ length: 80 }, (_, index) => reviewerPointsAt(index, 5));
    for (let index = 1; index < tail.length; index += 1) {
      expect(tail[index]).toBeGreaterThan(0);
      expect(tail[index]).toBeLessThanOrEqual(tail[index - 1]);
    }
    expect(tail[5]).toBeGreaterThan(2);
    expect(tail.at(-1)).toBe(MIN_POINT_AWARD);
    expect(reviewerPointsAt(-1, 5)).toBe(0);
    expect(reviewerPointsAt(0, 0)).toBe(0);
  });

  it("formats decimal awards without trailing zeros", () => {
    expect(formatPoints(10)).toBe("10");
    expect(formatPoints(4.5)).toBe("4.5");
    expect(formatPoints(8.1)).toBe("8.1");
    expect(formatPoints(-5)).toBe("-5");
    expect(formatPoints(0)).toBe("0");
    expect(pointsNumber(null)).toBe(0);
    expect(pointsNumber({ toNumber: () => 1.5 })).toBe(1.5);
  });

  it("builds one source key per role, issue and person", () => {
    expect(pointSourceKey("solver", "bug-1", "user-1")).toBe("solver:bug-1:user-1");
    expect(pointSourceKey("reporter", "bug-1", "user-1")).toBe("reporter:bug-1:user-1");
    expect(pointSourceKey("reviewer", "bug-1", "user-1")).toBe("reviewer:bug-1:user-1");
    expect(pointSourceKey("solver", "bug-1", "user-2")).not.toBe(pointSourceKey("solver", "bug-1", "user-1"));
    expect(confirmationReviewerSourceKey("bug-1", "user-1")).toBe("reviewer-confirm:bug-1:user-1");
    expect(confirmationReviewerSourceKey("bug-1", "user-1")).not.toBe(pointSourceKey("reviewer", "bug-1", "user-1"));
  });

  describe("progress toward 500 points", () => {
    it("starts at zero", () => {
      expect(pointsProgress(0, 0)).toEqual({
        points: 0,
        solvedTasks: 0,
        pointsPercent: 0,
        targetMet: false,
      });
    });

    it("reports partial progress", () => {
      const progress = pointsProgress(250, 5);
      expect(progress.pointsPercent).toBe(50);
      expect(progress.solvedTasks).toBe(5);
      expect(progress.targetMet).toBe(false);
    });

    it("is met at 500 points with no solved tasks", () => {
      const progress = pointsProgress(500, 0);
      expect(progress.pointsPercent).toBe(100);
      expect(progress.targetMet).toBe(true);
    });

    it("is not met below 500 points", () => {
      expect(pointsProgress(400, 20).targetMet).toBe(false);
    });

    it("stays met above 500 points", () => {
      expect(pointsProgress(800, 25)).toMatchObject({ pointsPercent: 100, targetMet: true });
    });

    it("never shows a negative percentage after a correction", () => {
      expect(pointsProgress(-10, 0).pointsPercent).toBe(0);
    });

    it("uses an optional target override for the goal", () => {
      expect(pointsProgress(100, 0, 200)).toMatchObject({
        pointsPercent: 50,
        targetMet: false,
      });
      expect(pointsProgress(200, 0, 200).targetMet).toBe(true);
    });
  });
});
