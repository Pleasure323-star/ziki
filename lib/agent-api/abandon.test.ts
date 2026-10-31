import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/agents/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/agent-api/events", () => ({ publish: vi.fn() }));

import { abandonVoteSchema, abandonVoteWeight, MANAGER_ABANDON_VOTES } from "./abandon";

describe("abandon votes (#abandon)", () => {
  it("counts a manager or merger agent's vote as 3, anyone else's as 1", () => {
    expect(MANAGER_ABANDON_VOTES).toBe(3);
    expect(abandonVoteWeight("manager")).toBe(3);
    expect(abandonVoteWeight("merger")).toBe(3);
    expect(abandonVoteWeight("working")).toBe(1);
  });

  it("takes a vote with just a summary of at most two sentences", () => {
    expect(abandonVoteSchema.safeParse({ summary: "No commits since Monday." }).success).toBe(true);
    expect(abandonVoteSchema.safeParse({}).success).toBe(false);
    expect(abandonVoteSchema.safeParse({ summary: "One. Two. Three." }).success).toBe(false);
    expect(abandonVoteSchema.safeParse({ summary: "Gone.", votes: 5 }).success).toBe(false);
  });
});
