import { describe, expect, it } from "vitest";
import { confirm, fileIssue, ok, refused } from "./helpers";

type Action = { action: string; route: string; minimumRole: string; canAct: boolean; blockedReason?: string };
type Item = {
  issue: { id: string; number: number; status: string; url: string };
  holder: { state: string; staleAssignee: boolean };
  pullRequest: { url: string | null; linkState: string; state: string };
  judgements: { good: number; notGood: number; needed: number } | null;
  bids: { open: number } | null;
  nextActions: Action[];
};
type Page = { items: Item[]; nextCursor: string | null };

const LINK_STATES = ["ok", "old_repository", "other_repository", "missing", "unknown"];
/** Ziki never asks GitHub (#pr-reports): the state is the latest agent report, or unreported. */
const PR_STATES = ["open", "closed", "merged", "not_found", "unreported"];

/** The manager's triage view: `GET /api/v1/triage`, or `pnpm ziki triage` (#triage). */
describe("triage", () => {
  /** Every page of dana's triage. */
  async function allItems(): Promise<{ items: Item[] }> {
    const items: Item[] = [];
    let cursor: string | null = null;
    do {
      const page = (await ok("dana", "triage", { limit: 100, ...(cursor ? { cursor } : {}) })) as Page;
      expect(page).not.toHaveProperty("githubAvailable");
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return { items };
  }

  it("lists an Open issue with bids for a manager: a vote below the threshold, then the award", async () => {
    const issue = await fileIssue("ada", "Triage: an issue with a bid", ["bob", "cara", "eli"]);
    await confirm(issue, ["bob", "cara"]);
    const bidId = (await ok("cara", "bid", { id: issue, summary: "I can fix this.", description: "I will reproduce it, fix it and add a test." })).bid_id;

    // Below the threshold, the next action is a vote, not an award.
    const before = (await allItems()).items.find((entry) => entry.issue.id === issue);
    expect(before!.nextActions.find((action) => action.action === "award_bid")).toBeUndefined();
    expect(before!.nextActions.find((action) => action.action === "vote_bid")).toMatchObject({ minimumRole: "working", canAct: true });
    // dana's vote counts 3, the default awardThreshold.
    await ok("dana", "vote-bid", { id: bidId });

    const { items } = await allItems();
    const item = items.find((entry) => entry.issue.id === issue);
    expect(item, "the Open issue with a bid is in the triage").toBeTruthy();
    expect(item!.issue.status).toBe("open");
    expect(item!.bids).toEqual({ open: 1 });
    expect(item!.holder).toMatchObject({ state: "none", staleAssignee: false });
    expect(item!.pullRequest).toMatchObject({ url: null, linkState: "missing" });
    const award = item!.nextActions.find((action) => action.action === "award_bid");
    expect(award).toMatchObject({ minimumRole: "working", canAct: true });
    expect(award!.route).toMatch(/^\/api\/v1\/bids\/[^/]+\/award\?projectId=/);

    // Every item names its link state and says why a blocked action is blocked.
    for (const entry of items) {
      expect(LINK_STATES).toContain(entry.pullRequest.linkState);
      expect(PR_STATES).toContain(entry.pullRequest.state);
      for (const action of entry.nextActions) if (!action.canAct) expect(action.blockedReason).toBeTruthy();
      expect(["in_progress", "delivered", "done", "ready_to_merge", "open"]).toContain(entry.issue.status);
    }
  });

  it("pages with a cursor", async () => {
    const first = (await ok("dana", "triage", { limit: 1 })) as Page;
    expect(first.items.length).toBeLessThanOrEqual(1);
    if (first.nextCursor) {
      const second = (await ok("dana", "triage", { limit: 1, cursor: first.nextCursor })) as Page;
      expect(second.items[0]?.issue.id).not.toBe(first.items[0].issue.id);
    }
  });

  it("refuses a working agent", async () => {
    const body = await refused("bob", "triage", {}, 403);
    expect(body.error).toBe("insufficient_level");
  });
});
