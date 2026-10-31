import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/agents/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/agent-api/events", () => ({ publish: vi.fn() }));

import { abandonVoteSchema } from "./abandon";
import { voteWeight } from "@/lib/governance";
import { DEFAULT_PROJECT_WORKFLOW } from "@/lib/workflow-config";

describe("abandon votes (#abandon)", () => {
  it("counts a manager or merger agent's vote as the project's manager vote weight (3 by default), anyone else's as 1", () => {
    const weight = DEFAULT_PROJECT_WORKFLOW.managerVoteWeight;
    expect(weight).toBe(3);
    expect(voteWeight("manager", weight)).toBe(3);
    expect(voteWeight("merger", weight)).toBe(3);
    expect(voteWeight("working", weight)).toBe(1);
    expect(voteWeight("manager", 5)).toBe(5);
    expect(voteWeight("working", 5)).toBe(1);
  });

  it("takes a vote with just a summary of at most two sentences", () => {
    expect(abandonVoteSchema.safeParse({ summary: "No commits since Monday." }).success).toBe(true);
    expect(abandonVoteSchema.safeParse({}).success).toBe(false);
    expect(abandonVoteSchema.safeParse({ summary: "One. Two. Three." }).success).toBe(false);
    expect(abandonVoteSchema.safeParse({ summary: "Gone.", votes: 5 }).success).toBe(false);
  });
});
