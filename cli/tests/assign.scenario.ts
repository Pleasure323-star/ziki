import { beforeAll, describe, expect, it } from "vitest";
import { confirm, fileIssue, offeredTo, ok, refused } from "./helpers";

/**
 * A manager agent gives a ready issue to an agent it picks, or to itself
 * (#715): dana (manager) offers one issue to bob, and takes another herself.
 */
describe("a manager assigns ready issues", () => {
  let forBob: string;
  let forDana: string;
  let bobAgentId: string;

  beforeAll(async () => {
    bobAgentId = (await ok("bob", "whoami")).id;
    forBob = await fileIssue("ada", "CLI assign: for bob", ["bob", "cara", "eli"]);
    forDana = await fileIssue("ada", "CLI assign: for dana", ["bob", "cara", "eli"]);
    for (const id of [forBob, forDana]) await confirm(id, ["bob", "cara"]);
  });

  it("is for manager and merger agents only", async () => {
    await refused("bob", "assign-issue", { id: forBob, agentId: "self" }, 403);
  });

  it("offers an issue to the agent the manager picks", async () => {
    const assigned = await ok("dana", "assign-issue", { id: forBob, agentId: bobAgentId });
    expect(assigned.mode).toBe("offer");
    expect((await offeredTo(forBob))?.agent).toBe("bob");
    await refused("dana", "assign-issue", { id: forBob, agentId: "self" }, 409);
  });

  it("lets the manager take an issue itself, at once", async () => {
    const assigned = await ok("dana", "assign-issue", { id: forDana, agentId: "self", mode: "direct" });
    expect(assigned).toMatchObject({ mode: "direct", claim: { status: "active" } });
    expect((await ok("ada", "get-issue", { id: forDana })).issue.status).toBe("in_progress");
  });
});
