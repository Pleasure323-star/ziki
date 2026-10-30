import { describe, expect, it, vi } from "vitest";
import {
  hardCodedPlatformRewards,
  parsePlatformRewardConfig,
  getPlatformRewardConfig,
  getProjectRewardConfig,
} from "./platform-rewards";
import { SOLVER_POINTS, REPORTER_POINTS, REVIEWER_POINTS } from "./rules";

describe("platform reward config", () => {
  it("falls back to hard-coded amounts when nothing is stored", () => {
    const hard = hardCodedPlatformRewards();
    expect(parsePlatformRewardConfig(null)).toEqual(hard);
    expect(parsePlatformRewardConfig({})).toMatchObject({
      reporter: REPORTER_POINTS,
      reviewer: REVIEWER_POINTS,
      solver: SOLVER_POINTS,
    });
  });

  it("keeps custom platform amounts when valid", () => {
    const parsed = parsePlatformRewardConfig({
      solver: 40,
      reporter: 7,
      reviewer: 12,
      confirmationReviewer: 4,
      triagerClear: 2,
      duplicateMarker: 6,
      dispatcher: 3,
      target: 600,
    });
    expect(parsed.solver).toBe(40);
    expect(parsed.reporter).toBe(7);
    expect(parsed.target).toBe(600);
  });

  it("getPlatformRewardConfig uses hard-coded amounts when the table is missing", async () => {
    const db = {
      platformSettings: {
        findUnique: vi.fn().mockRejectedValue(new Error("relation missing")),
      },
    };
    const config = await getPlatformRewardConfig(db as never);
    expect(config).toEqual(hardCodedPlatformRewards());
  });

  it("getProjectRewardConfig prefers project override, then platform, then hard-coded", async () => {
    const db = {
      platformSettings: {
        findUnique: vi.fn().mockResolvedValue({
          rewardConfig: {
            solver: 40,
            reporter: 7,
            reviewer: 12,
          },
        }),
      },
      project: {
        findUnique: vi.fn().mockResolvedValue({
          rewardConfig: { reporter: 9 },
        }),
      },
    };
    const config = await getProjectRewardConfig(db as never, "proj-1");
    expect(config.reporter).toBe(9);
    expect(config.solver).toBe(40);
    expect(config.reviewer).toBe(12);
  });
});
