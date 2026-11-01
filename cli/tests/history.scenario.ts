import { beforeAll, describe, expect, it } from "vitest";
import { confirm, fileIssue, ok, refused } from "./helpers";

type Item = {
  kind: string;
  id: string;
  createdAt: string;
  summary?: string;
  status?: string;
  agent: { id: string; name: string } | null;
  issue?: { id: string; status: string };
  edit: { method: string; path: string; cli: string } | null;
};
type Page = { items: Item[]; nextCursor: string | null };

/**
 * An owner's history (#owner-history): ada files an issue, bob and cara
 * confirm it, then bob bids. bob's history lists his bid and his confirmation
 * newest first, says how to replace the bid (the issue is Open) and not the
 * confirmation (its step has passed), filters by kind, pages with limit=1, and
 * never shows another owner's entries.
 */
describe("an owner's history of entries", () => {
  let id: string;
  let bidId: string;

  const history = async (flags: Record<string, string | number> = {}) => (await ok("bob", "get-history", flags)) as Page;
  const forIssue = (items: Item[]) => items.filter((item) => item.issue?.id === id);

  beforeAll(async () => {
    id = await fileIssue("ada", "CLI history: the export menu closes on hover", ["bob", "cara", "eli"]);
    await confirm(id, ["bob", "cara"]);
    bidId = (await ok("bob", "bid", { id, summary: "I can fix the export menu.", description: "The hover handler closes the menu; I will keep it open while the pointer is inside." })).bid_id;
  });

  it("lists the bid and the confirmation newest first, with how to replace each", async () => {
    const mine = forIssue((await history({ kind: "bid,confirmation" })).items);
    expect(mine.map((item) => item.kind)).toEqual(["bid", "confirmation"]);
    const [bid, confirmation] = mine;
    expect(bid).toMatchObject({ id: bidId, status: "open", summary: "I can fix the export menu.", agent: { name: "bob" }, issue: { status: "open" } });
    expect(bid.edit).toMatchObject({ method: "POST" });
    expect(bid.edit!.path).toContain(`/api/v1/issues/${id}/bid`);
    expect(bid.edit!.cli).toContain(`bid --id ${id}`);
    // The issue is past Requires confirmation, so the confirmation can't be replaced.
    expect(confirmation.edit).toBeNull();
    expect(Date.parse(bid.createdAt)).toBeGreaterThanOrEqual(Date.parse(confirmation.createdAt));
  });

  it("replaces the bid through its edit route, keeping it the same entry", async () => {
    await ok("bob", "bid", { id, summary: "I will fix the export menu.", description: "Keep the menu open while the pointer is inside it, with a test." });
    const [bid] = forIssue((await history({ kind: "bid" })).items);
    expect(bid).toMatchObject({ id: bidId, summary: "I will fix the export menu." });
  });

  it("filters by kind", async () => {
    const bids = (await history({ kind: "bid" })).items;
    expect(bids.length).toBeGreaterThan(0);
    expect(bids.every((item) => item.kind === "bid")).toBe(true);
    const verdicts = (await history({ kind: "idea_verdict" })).items;
    expect(verdicts.every((item) => item.kind === "idea_verdict")).toBe(true);
    expect(forIssue(verdicts)).toEqual([]);
    expect((await refused("bob", "get-history", { kind: "vote" }, 400)).error).toBeTruthy();
  });

  it("pages one item at a time with nextCursor, without repeats", async () => {
    const all = (await history({ kind: "bid,confirmation", limit: 100 })).items.map((item) => item.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < all.length + 1; pages += 1) {
      const page: Page = await history({ kind: "bid,confirmation", limit: 1, ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(1);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
    // Newest first: bob's bid on this issue comes before his confirmation of it.
    const confirmationId = forIssue((await history({ kind: "confirmation" })).items)[0].id;
    expect(seen.indexOf(bidId)).toBeLessThan(seen.indexOf(confirmationId));
    await refused("bob", "get-history", { cursor: "not-a-cursor" }, 400);
  });

  it("never shows another owner's entries", async () => {
    const ada = (await ok("ada", "get-history", { kind: "bid,confirmation", limit: 100 })) as Page;
    expect(ada.items.map((item) => item.id)).not.toContain(bidId);
    // ada confirmed her own issue (#confirmation-weights): only that entry is hers here.
    expect(forIssue(ada.items).map((item) => [item.kind, item.agent?.name])).toEqual([["confirmation", "ada"]]);
    const bob = (await history({ limit: 100 })).items;
    for (const item of bob) {
      if (item.agent) expect(item.agent.name).toBe("bob");
    }
    const cara = forIssue(((await ok("cara", "get-history", { kind: "confirmation" })) as Page).items);
    expect(cara).toHaveLength(1);
    expect(cara[0].agent?.name).toBe("cara");
  });
});
