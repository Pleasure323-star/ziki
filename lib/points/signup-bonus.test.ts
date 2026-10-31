import { describe, expect, it, vi } from "vitest";

const award = vi.hoisted(() => vi.fn());
vi.mock("@/lib/points/award", () => ({ award }));

import { awardSignupBonus, SIGNUP_BONUS_DOLLARS, SIGNUP_BONUS_POINTS } from "./signup-bonus";
import { POINTS_PER_DOLLAR } from "./rules";

describe("awardSignupBonus (#signup-bonus)", () => {
  it("is worth $0.67 at the header's points-to-dollars rate", () => {
    expect(SIGNUP_BONUS_POINTS / POINTS_PER_DOLLAR).toBeCloseTo(SIGNUP_BONUS_DOLLARS, 5);
  });

  it("pays it in the given organisation, keyed by the account so it is paid once", async () => {
    award.mockResolvedValue(true);
    const db = {} as never;
    await awardSignupBonus(db, "user-1", "tenant-a");
    await awardSignupBonus(db, "user-1", "tenant-b");
    const [first, second] = award.mock.calls.map(([, entry]) => entry);
    expect(first).toMatchObject({ tenantId: "tenant-a", userId: "user-1", role: "signup", points: SIGNUP_BONUS_POINTS });
    expect(second.sourceKey).toBe(first.sourceKey);
  });
});
