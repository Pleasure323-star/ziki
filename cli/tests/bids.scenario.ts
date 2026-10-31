import { beforeAll, describe, expect, it } from "vitest";
import { confirm, fileIssue, offeredTo, ok, refused, type Agent } from "./helpers";

type Item = { kind: string; key: string; canAct: boolean; blockedReason?: string; issue?: { id: string }; actions: { name: string; cli: string }[] };

/**
 * Offers only through bids, awarded by votes (#bids-only-offers, #bid-votes).
 * ada files the issue; bob and cara bid; ada and cara vote for bob's bid (1
 * each), which is still short of the default awardThreshold of 3, so nobody
 * may award it, dana (the manager agent) included. dana's vote counts 3 and
 * takes it over; then ada, a working agent, awards it as an offer and bob
 * accepts. Nothing offers the issue on its own.
 */
describe("bids, votes and an award once the votes reach the threshold", () => {
  let id: string;
  let bobBid: string;
  let caraBid: string;

  const items = async (agent: Agent) => (await ok(agent, "work")).items as Item[];
  const byKey = async (agent: Agent, key: string) => (await items(agent)).find((item) => item.key === key);

  beforeAll(async () => {
    id = await fileIssue("ada", "CLI bids: the export button is greyed out", ["bob", "cara", "eli"]);
    await confirm(id, ["bob", "cara"]);
  });

  it("takes bids from bob and cara, and offers the issue to nobody on its own", async () => {
    bobBid = (await ok("bob", "bid", { id, summary: "I can fix the export button.", description: "The button's disabled state never clears after a failed export; I will reset it and add a test." })).bid_id;
    caraBid = (await ok("cara", "bid", { id, summary: "I can fix it too.", description: "I would rewrite the export state machine." })).bid_id;
    expect(bobBid).toBeTruthy();
    expect(caraBid).toBeTruthy();
    expect(await offeredTo(id)).toBeNull();
    expect((await ok("ada", "get-issue", { id })).issue).toMatchObject({ status: "open", holder: null });
  });

  it("asks agents to vote for each bid, and drops the item once they have", async () => {
    const item = await byKey("ada", `review_bid:${bobBid}`);
    expect(item).toMatchObject({ kind: "review_bid", canAct: true, issue: { id } });
    expect(item!.actions.map((action) => action.cli)).toEqual([`vote-bid --id ${bobBid}`]);
    expect(await ok("ada", "vote-bid", { id: bobBid })).toMatchObject({ bidId: bobBid, votes: 1, threshold: 3, awarded: false });
    // Voting again is fine and counts once.
    expect(await ok("ada", "vote-bid", { id: bobBid })).toMatchObject({ bidId: bobBid, votes: 1, awarded: false });
    expect(await byKey("ada", `review_bid:${bobBid}`)).toBeUndefined();
    expect(await byKey("ada", `review_bid:${caraBid}`)).toBeTruthy();
    // cara bids too, and may still vote for bob's bid.
    expect(await ok("cara", "vote-bid", { id: bobBid })).toMatchObject({ bidId: bobBid, votes: 2, threshold: 3, awarded: false });
    const listed = (await ok("ada", "list-bids", { id })).bids as { id: string; votes: number }[];
    expect(listed.find((bid) => bid.id === bobBid)?.votes).toBe(2);
  });

  it("refuses a working agent's vote for its own owner's bid", async () => {
    expect((await refused("bob", "vote-bid", { id: bobBid }, 403)).error).toBe("own_bid");
    expect(await byKey("bob", `review_bid:${bobBid}`)).toBeUndefined();
  });

  it("refuses every award below the threshold, a manager's too, and lists none", async () => {
    const body = await refused("dana", "award-bid", { id: bobBid }, 409);
    expect(body).toMatchObject({ error: "below_threshold", votes: 2, threshold: 3 });
    await refused("ada", "award-bid", { id: bobBid }, 409);
    expect(await byKey("dana", `award_bid:${id}`)).toBeUndefined();
    expect(await byKey("ada", `award_bid:${id}`)).toBeUndefined();
    expect(await offeredTo(id)).toBeNull();
  });

  it("counts a manager's vote 3, which takes the bid to the threshold", async () => {
    expect(await byKey("dana", `review_bid:${bobBid}`)).toMatchObject({ kind: "review_bid", canAct: true });
    expect(await ok("dana", "vote-bid", { id: bobBid })).toMatchObject({ bidId: bobBid, votes: 5, threshold: 3, awarded: false });
  });

  it("lists the award for every agent once a bid reached the threshold", async () => {
    for (const agent of ["ada", "cara", "dana", "eli"] as const) {
      const item = await byKey(agent, `award_bid:${id}`);
      expect(item, `${agent} sees the award`).toMatchObject({ kind: "award_bid", canAct: true, minimumRole: "working" });
      // Only the bid at the threshold, not cara's.
      expect(item!.actions.map((action) => action.cli)).toEqual([`award-bid --id ${bobBid}`]);
    }
    await refused("ada", "award-bid", { id: caraBid }, 409);
  });

  it("is awarded by ada, a working agent, as an offer: the issue stays Open until bob accepts", async () => {
    const awarded = await ok("ada", "award-bid", { id: bobBid });
    expect(awarded).toMatchObject({ bidId: bobBid, bugId: id, status: "offered" });
    expect((await ok("ada", "get-issue", { id })).issue).toMatchObject({
      status: "open",
      holder: { status: "offered", via: "bid", agentName: "bob" },
    });
    // One award at a time.
    await refused("dana", "award-bid", { id: caraBid }, 409);

    const offer = await byKey("bob", `offer:${awarded.claimId}`);
    expect(offer?.issue?.id).toBe(id);
    expect(offer?.actions[0].cli).toBe(`accept-offer --id ${awarded.claimId}`);
    const accepted = await ok("bob", "accept-offer", { id: awarded.claimId });
    expect(accepted.claim.status).toBe("active");
    expect((await ok("ada", "get-issue", { id })).issue).toMatchObject({ status: "in_progress", holder: { status: "active", via: "bid", agentName: "bob" } });
  });

  it("withdraws the other bids once the offer is accepted", async () => {
    const open = (await ok("ada", "list-bids", { id })).bids as { id: string }[];
    expect(open.map((bid) => bid.id)).not.toContain(caraBid);
    expect(await byKey("eli", `review_bid:${caraBid}`)).toBeUndefined();
    // bob is done with it, so it goes back to Open for bids.
    expect(await ok("bob", "release-claim", { id, reason: "Done testing bids." })).toMatchObject({ reopened: true });
  });
});

/**
 * A manager acts through the same votes, and reaches the threshold alone
 * (#bid-votes): dana bids, votes for its own owner's bid (a manager may; its
 * vote counts 3, the default awardThreshold) and awards it.
 */
describe("a manager votes its own owner's bid to the threshold and awards it", () => {
  let id: string;
  let danaBid: string;

  beforeAll(async () => {
    id = await fileIssue("ada", "CLI bids: a manager's own bid", ["bob", "cara", "eli"]);
    await confirm(id, ["bob", "cara"]);
    danaBid = (await ok("dana", "bid", { id, summary: "I will fix it myself.", description: "A one-line fix to the export handler, with a test." })).bid_id;
  });

  it("is refused below the threshold, then awarded once dana's own vote reaches it", async () => {
    expect(await refused("dana", "award-bid", { id: danaBid }, 409)).toMatchObject({ error: "below_threshold", votes: 0, threshold: 3 });
    expect(await ok("dana", "vote-bid", { id: danaBid })).toMatchObject({ bidId: danaBid, votes: 3, threshold: 3, awarded: false });
    const awarded = await ok("dana", "award-bid", { id: danaBid });
    expect(awarded).toMatchObject({ bidId: danaBid, bugId: id, status: "offered" });
    const accepted = await ok("dana", "accept-offer", { id: awarded.claimId });
    expect(accepted.claim.status).toBe("active");
    expect(await ok("dana", "release-claim", { id, reason: "Done testing a manager's own award." })).toMatchObject({ reopened: true });
  });
});
