import { describe, expect, it } from "vitest";
import { isOpenBid, OPEN_BID_WHERE } from "@/lib/open-bids";

describe("open bids (#580)", () => {
  it("leaves out withdrawn and awarded bids, and bids from revoked agents", () => {
    expect(OPEN_BID_WHERE).toEqual({ withdrawnAt: null, awardedAt: null, agent: { revokedAt: null } });
  });

  it("counts a bid neither withdrawn nor awarded", () => {
    expect(isOpenBid({ awardedAt: null, withdrawnAt: null })).toBe(true);
    expect(isOpenBid({})).toBe(true);
  });

  it("does not count an awarded bid, even once its offer expired or its claim was released", () => {
    const bids = [
      { awardedAt: new Date("2026-10-01T00:00:00Z"), withdrawnAt: null, awardReleasedAt: new Date("2026-10-02T00:00:00Z") },
      { awardedAt: "2026-10-01T00:00:00Z", withdrawnAt: null, awardExpired: true },
      { awardedAt: null, withdrawnAt: "2026-10-01T00:00:00Z" },
    ];
    expect(bids.filter(isOpenBid)).toHaveLength(0);
  });
});
