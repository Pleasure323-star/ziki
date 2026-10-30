import { beforeAll, describe, expect, it } from "vitest";
import { confirm, fileIssue, offeredTo, ok, refused, type Agent } from "./helpers";

type Item = { kind: string; key: string; canAct: boolean; blockedReason?: string; issue?: { id: string }; actions: { name: string; cli: string }[] };

/**
 * Offers only through bids, awarded by managers (#bids-only-offers, #bid-votes).
 * ada files the issue; bob and cara bid; eli votes for bob's bid; dana (the
 * sandbox manager agent, owned by someone else) awards it as an offer, and bob
 * accepts. Nothing offers the issue on its own.
 */
describe("bids, votes and a manager's award", () => {
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

  it("asks other agents to vote for each bid, and drops the item once they have", async () => {
    const item = await byKey("eli", `review_bid:${bobBid}`);
    expect(item).toMatchObject({ kind: "review_bid", canAct: true, issue: { id } });
    expect(item!.actions.map((action) => action.cli)).toEqual([`vote-bid --id ${bobBid}`]);
    expect(await ok("eli", "vote-bid", { id: bobBid })).toEqual({ bidId: bobBid, votes: 1 });
    // Voting again is fine and counts once.
    expect(await ok("eli", "vote-bid", { id: bobBid })).toEqual({ bidId: bobBid, votes: 1 });
    expect(await byKey("eli", `review_bid:${bobBid}`)).toBeUndefined();
    expect(await byKey("eli", `review_bid:${caraBid}`)).toBeTruthy();
    const listed = (await ok("ada", "list-bids", { id })).bids as { id: string; votes: number }[];
    expect(listed.find((bid) => bid.id === bobBid)?.votes).toBe(1);
  });

  it("refuses a vote for the voter's own bid", async () => {
    expect((await refused("bob", "vote-bid", { id: bobBid }, 403)).error).toBe("own_bid");
    expect(await byKey("bob", `review_bid:${bobBid}`)).toBeUndefined();
  });

  it("lists the award for managers, and shows it to working agents without letting them act", async () => {
    const forDana = await byKey("dana", `award_bid:${id}`);
    expect(forDana).toMatchObject({ kind: "award_bid", canAct: true });
    // The most voted bid first.
    expect(forDana!.actions.map((action) => action.cli)).toEqual([`award-bid --id ${bobBid}`, `award-bid --id ${caraBid}`]);
    expect(await byKey("ada", `award_bid:${id}`)).toMatchObject({ canAct: false, blockedReason: "Needs a manager agent." });
    // eli is a merger agent, so it may award too.
    expect(await byKey("eli", `award_bid:${id}`)).toMatchObject({ canAct: true });
  });

  it("refuses an award from a working agent", async () => {
    await refused("cara", "award-bid", { id: bobBid }, 403);
    expect(await offeredTo(id)).toBeNull();
  });

  it("is awarded by dana as an offer: the issue stays Open until bob accepts", async () => {
    const awarded = await ok("dana", "award-bid", { id: bobBid });
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
