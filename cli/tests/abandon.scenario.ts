import { beforeAll, describe, expect, it } from "vitest";
import { confirm, feedItem, fileIssue, ok, refused } from "./helpers";

/**
 * Sense checks on stale in-progress work (#abandon). The sandbox puts work up
 * for a check at once (its abandonCheckMinutes is 0), so this need not wait
 * six hours. bob holds an issue; cara and dana check it. cara's vote counts 1,
 * dana's (a manager agent) 3, and the default threshold is 3.
 */
describe("agents vote stale work abandoned", () => {
  let id: string;

  beforeAll(async () => {
    id = await fileIssue("ada", "CLI abandon: stale work", ["bob", "cara", "eli"]);
    await confirm(id, ["bob", "cara"]);
    const bobAgentId = (await ok("bob", "whoami")).id;
    const assigned = await ok("dana", "assign-issue", { id, agentId: bobAgentId, mode: "direct" });
    expect(assigned).toMatchObject({ mode: "direct", claim: { status: "active" } });
    expect((await ok("ada", "get-issue", { id })).issue.status).toBe("in_progress");
  });

  it("puts the work up for a sense check, for everyone but its holder", async () => {
    const item = await feedItem("cara", "sense_check", id);
    expect(item?.actions?.map((action) => action.name)).toEqual(["vote_abandoned"]);
    expect(await feedItem("bob", "sense_check", id)).toBeUndefined();
  });

  it("refuses the holder's own vote", async () => {
    const body = await refused("bob", "vote-abandoned", { id, summary: "I gave up on it." }, 403);
    expect(body.error).toBe("own_work");
  });

  it("counts one working agent's vote as 1, below the threshold", async () => {
    const vote = await ok("cara", "vote-abandoned", { id, summary: "No commits or comments for a day." });
    expect(vote).toMatchObject({ votes: 1, threshold: 3, abandoned: false, status: "in_progress" });
    // A newer vote from the same person replaces theirs; it doesn't add up.
    const again = await ok("cara", "vote-abandoned", { id, summary: "Still nothing, and the branch is gone." });
    expect(again).toMatchObject({ votes: 1, abandoned: false });
    // Once voted, it leaves that agent's feed.
    expect(await feedItem("cara", "sense_check", id)).toBeUndefined();
  });

  it("takes it back to Open, unawarded, once a manager agent's vote crosses the threshold", async () => {
    const vote = await ok("dana", "vote-abandoned", { id, summary: "Nobody is on it; back to the queue." });
    expect(vote).toMatchObject({ votes: 4, threshold: 3, abandoned: true, status: "open" });
    const issue = (await ok("ada", "get-issue", { id })).issue;
    expect(issue.status).toBe("open");
    expect(issue.assigneeId ?? null).toBeNull();
    expect(issue.holder ?? null).toBeNull();
  });

  it("has nothing to check once nobody holds it", async () => {
    const body = await refused("eli", "vote-abandoned", { id, summary: "Checking." }, 409);
    expect(body.error).toBe("not_in_progress");
    expect(await feedItem("eli", "sense_check", id)).toBeUndefined();
  });
});
