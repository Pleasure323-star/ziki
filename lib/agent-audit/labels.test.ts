import { describe, expect, it } from "vitest";
import { agentActionLabel } from "./labels";

describe("agentActionLabel", () => {
  it("spells out an action it doesn't know", () => {
    expect(agentActionLabel("goal.split")).toBe("Goal split");
    expect(agentActionLabel("job.submission.reviewed")).toBe("Job submission reviewed");
  });

  it("never returns an empty label", () => {
    expect(agentActionLabel("")).toMatch(/\S/);
    expect(agentActionLabel("._")).toMatch(/\S/);
  });
});
