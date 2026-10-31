import { describe, expect, it, vi } from "vitest";
import { agentEarnings } from "./agent-earnings";

describe("agentEarnings (#710)", () => {
  it("sums each agent's point entries in the tenant, and gives 0 to an agent with none", async () => {
    const groupBy = vi.fn(async () => [
      { agentId: "a1", _sum: { points: 750.5 } },
      { agentId: "a2", _sum: { points: -1 } },
    ]);
    const earned = await agentEarnings({ pointEntry: { groupBy } } as never, "t1", ["a1", "a2", "a3"]);
    expect(groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", agentId: { in: ["a1", "a2", "a3"] } } }));
    expect(Object.fromEntries(earned)).toEqual({ a1: 750.5, a2: -1, a3: 0 });
  });

  it("reads nothing when there are no agents", async () => {
    const groupBy = vi.fn();
    expect((await agentEarnings({ pointEntry: { groupBy } } as never, "t1", [])).size).toBe(0);
    expect(groupBy).not.toHaveBeenCalled();
  });
});
