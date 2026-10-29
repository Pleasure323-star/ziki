import { describe, expect, it, vi } from "vitest";

const validations = vi.hoisted(() => vi.fn());
const verdicts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({
  prisma: { issueConfirmation: { groupBy: validations }, testVerdict: { groupBy: verdicts } },
}));

import { agentWorkDone, describeWorkDone } from "./agent-work";

describe("agentWorkDone", () => {
  it("counts each agent's confirmations, rejections and fix reviews over the last 30 days", async () => {
    validations.mockResolvedValue([
      { agentId: "a1", verdict: "confirm", _count: { _all: 3 } },
      // A person's own entries have no agent.
      { agentId: null, verdict: "confirm", _count: { _all: 5 } },
      { agentId: "a1", verdict: "reject", _count: { _all: 1 } },
    ]);
    verdicts.mockResolvedValue([{ agentId: "a2", _count: { _all: 2 } }]);
    const now = new Date("2026-10-25T00:00:00Z");
    const done = await agentWorkDone(["a1", "a2", "a3"], now);
    expect(done.get("a1")).toEqual({ confirmed: 3, rejected: 1, reviews: 0 });
    expect(done.get("a2")).toEqual({ confirmed: 0, rejected: 0, reviews: 2 });
    expect(done.has("a3")).toBe(false);
    expect(validations).toHaveBeenCalledWith(expect.objectContaining({
      where: { agentId: { in: ["a1", "a2", "a3"] }, verdict: { in: ["confirm", "reject"] }, updatedAt: { gte: new Date("2026-09-25T00:00:00Z") } },
    }));
    const since = new Date("2026-09-25T00:00:00Z");
    expect(verdicts).toHaveBeenCalledWith(expect.objectContaining({
      where: { agentId: { in: ["a1", "a2", "a3"] }, OR: [{ createdAt: { gte: since } }, { changedAt: { gte: since } }] },
    }));
  });

  it("reads nothing for no agents", async () => {
    validations.mockClear();
    expect((await agentWorkDone([])).size).toBe(0);
    expect(validations).not.toHaveBeenCalled();
  });
});

describe("describeWorkDone", () => {
  it("names only what was done", () => {
    expect(describeWorkDone({ confirmed: 2, rejected: 0, reviews: 1 })).toBe("2 confirmed · 1 fix reviewed");
    expect(describeWorkDone({ confirmed: 0, rejected: 1, reviews: 3 })).toBe("1 rejected · 3 fixes reviewed");
    expect(describeWorkDone({ confirmed: 0, rejected: 0, reviews: 0 })).toBeNull();
    expect(describeWorkDone(undefined)).toBeNull();
  });
});
