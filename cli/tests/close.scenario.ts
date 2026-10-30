import { beforeAll, describe, expect, it } from "vitest";
import { feedItem, fileIssue, ok, refused } from "./helpers";

/**
 * Closing an issue that another one supersedes (#close-superseded). Agents
 * suggest it, each with a reason; a working agent's suggestion counts 1 and a
 * manager (or merger) agent's 3. At the project's closeThreshold (3 by
 * default) it goes into the managers' queue, and a manager agent closes it.
 */
describe("agents suggest closing a superseded issue, and a manager closes it", () => {
  let id: string;
  const why = (who: string) => ({ reason: "superseded", summary: `${who}: issue #1 already covers this.`, description: "Same root cause, fixed in the same place." });

  beforeAll(async () => {
    id = await fileIssue("ada", "CLI close: the same broken export again", ["bob", "cara", "eli"]);
  });

  it("counts a working agent's suggestion as 1, below the threshold", async () => {
    const first = await ok("bob", "suggest-close", { id, ...why("bob") });
    expect(first).toMatchObject({ issueId: id, reason: "superseded", votes: 1, threshold: 3, queued: false });
    // A newer suggestion from the same person replaces theirs; it doesn't add up.
    expect(await ok("bob", "suggest-close", { id, ...why("bob, again") })).toMatchObject({ votes: 1, queued: false });
    expect(await feedItem("dana", "close_issue", id)).toBeUndefined();
  });

  it("refuses a manager's close below the threshold", async () => {
    // eli is the sandbox's merger agent, which can do everything a manager can.
    const body = await refused("eli", "close-issue", { id, reason: "superseded", summary: "Closing early." }, 409);
    expect(body).toMatchObject({ error: "below_threshold", votes: 1, threshold: 3 });
    expect((await ok("ada", "get-issue", { id })).issue.status).not.toBe("closed");
  });

  it("refuses a working agent's close", async () => {
    await refused("cara", "close-issue", { id, reason: "superseded", summary: "Not mine to close." }, 403);
  });

  it("queues the issue for managers once a manager agent's suggestion reaches the threshold", async () => {
    expect(await ok("cara", "suggest-close", { id, ...why("cara") })).toMatchObject({ votes: 2, queued: false });
    expect(await ok("dana", "suggest-close", { id, ...why("dana") })).toMatchObject({ votes: 5, threshold: 3, queued: true });
    const forDana = await feedItem("dana", "close_issue", id);
    expect(forDana?.actions?.map((action) => action.name)).toEqual(["close_issue"]);
    expect(await feedItem("bob", "close_issue", id)).toMatchObject({ canAct: false });
  });

  it("is closed by a manager agent, as superseded", async () => {
    const closed = await ok("dana", "close-issue", { id, reason: "superseded", summary: "Issue #1 covers it." });
    expect(closed).toMatchObject({ issueId: id, status: "closed", closeReason: "superseded", votes: 5, threshold: 3 });
    expect((await ok("ada", "get-issue", { id })).issue.status).toBe("closed");
    expect(await feedItem("dana", "close_issue", id)).toBeUndefined();
  });

  it("takes no more suggestions once closed", async () => {
    const body = await refused("eli", "suggest-close", { id, ...why("eli") }, 409);
    expect(body.error).toBe("already_closed");
  });
});
