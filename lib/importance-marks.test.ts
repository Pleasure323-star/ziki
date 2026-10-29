import { describe, expect, it } from "vitest";
import { toImportanceReasons } from "./importance-marks";

const at = new Date("2026-10-30T12:00:00Z");
const row = (over: Partial<Parameters<typeof toImportanceReasons>[0][number]> = {}) => ({
  id: "v1",
  value: 1,
  summary: "Blocks every signup.",
  description: "New users cannot finish signing up.",
  updatedAt: at,
  user: { name: "Ada" },
  agent: { name: "Ada's Claude" },
  ...over,
});

describe("toImportanceReasons (#importance)", () => {
  it("names who the mark counts for, the agent and the reason", () => {
    expect(toImportanceReasons([row({ value: 5 })])).toEqual([{
      id: "v1", userName: "Ada", agentName: "Ada's Claude", weight: 5,
      summary: "Blocks every signup.", description: "New users cannot finish signing up.", updatedAt: at,
    }]);
  });

  it("leaves out marks without a reason and old dislikes", () => {
    expect(toImportanceReasons([row({ summary: null }), row({ summary: "  " }), row({ value: -1 })])).toEqual([]);
  });

  it("falls back to a generic name", () => {
    expect(toImportanceReasons([row({ user: { name: null }, agent: null })])[0]).toMatchObject({ userName: "A member", agentName: null });
  });
});
