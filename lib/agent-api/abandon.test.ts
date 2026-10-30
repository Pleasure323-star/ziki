import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/agents/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/agent-api/events", () => ({ publish: vi.fn() }));

import { abandonVoteSchema, abandonVoteWeight, isSenseCheckDue, lastUpdateAt, MANAGER_ABANDON_VOTES } from "./abandon";

describe("abandon votes (#abandon)", () => {
  it("counts a manager or merger agent's vote as 3, anyone else's as 1", () => {
    expect(MANAGER_ABANDON_VOTES).toBe(3);
    expect(abandonVoteWeight("manager")).toBe(3);
    expect(abandonVoteWeight("merger")).toBe(3);
    expect(abandonVoteWeight("working")).toBe(1);
  });

  it("takes the latest real update, ignoring missing dates", () => {
    const claimed = new Date("2026-10-30T08:00:00Z");
    const commented = new Date("2026-10-30T11:00:00Z");
    const changed = new Date("2026-10-30T09:30:00Z");
    expect(lastUpdateAt([claimed, null, commented, undefined, changed])).toEqual(commented);
    expect(lastUpdateAt([null, undefined])).toBeNull();
    expect(lastUpdateAt([])).toBeNull();
  });

  it("is due once the work has gone abandonCheckMinutes without an update, not before", () => {
    const last = new Date("2026-10-30T06:00:00Z");
    const sixHours = 360 * 60_000;
    expect(isSenseCheckDue(last, 360, last.getTime() + sixHours - 1)).toBe(false);
    expect(isSenseCheckDue(last, 360, last.getTime() + sixHours)).toBe(true);
    expect(isSenseCheckDue(last, 0, last.getTime())).toBe(true);
    // Nothing to measure from: never due.
    expect(isSenseCheckDue(null, 0, last.getTime())).toBe(false);
  });

  it("takes a vote with just a summary of at most two sentences", () => {
    expect(abandonVoteSchema.safeParse({ summary: "No commits since Monday." }).success).toBe(true);
    expect(abandonVoteSchema.safeParse({}).success).toBe(false);
    expect(abandonVoteSchema.safeParse({ summary: "One. Two. Three." }).success).toBe(false);
    expect(abandonVoteSchema.safeParse({ summary: "Gone.", votes: 5 }).success).toBe(false);
  });
});
