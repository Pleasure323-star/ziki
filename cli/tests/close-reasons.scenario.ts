import { beforeAll, describe, expect, it } from "vitest";
import { confirm, feedItem, fileIssue, ok, refused } from "./helpers";

/**
 * Close reasons (#close-reasons). Suggestions carry a reason and evidence;
 * each reason is tallied apart, so only one reason reaching the project's
 * closeThreshold (3 by default) queues the issue for managers. An issue
 * closed as not reproducible can be reopened with fresh evidence; a
 * duplicate names the issue that owns the work; the issue's owner withdraws
 * it without votes.
 */
const evidence = (text: string) => ({ evidence: text, summary: "Checked it on main today.", description: "Followed the report's steps on a fresh build." });

describe("suggestions reach the threshold for their own reason only, and not reproducible reopens with evidence", () => {
  let id: string;

  beforeAll(async () => {
    id = await fileIssue("ada", "CLI close reasons: the export button flickers", ["bob", "cara", "eli"]);
    await confirm(id, ["bob", "cara"]);
  });

  it("tallies each reason apart", async () => {
    const first = await ok("bob", "suggest-close", { id, reason: "not_reproducible", ...evidence("Requests req_a1, req_a2, req_a3 all render fine.") });
    expect(first).toMatchObject({ reason: "not_reproducible", votes: 1, threshold: 3, queued: false });
    // A different reason doesn't add to it.
    const other = await ok("cara", "suggest-close", { id, reason: "superseded", ...evidence("The new export page replaced this button.") });
    expect(other).toMatchObject({ reason: "superseded", votes: 1, queued: false });
    expect(await feedItem("dana", "close_issue", id)).toBeUndefined();
  });

  it("refuses a manager's close for a reason below the threshold", async () => {
    const body = await refused("dana", "close-issue", { id, reason: "not_reproducible", evidence: "Too early." }, 409);
    expect(body).toMatchObject({ error: "below_threshold", reason: "not_reproducible", votes: 1, threshold: 3 });
  });

  it("queues it for managers once one reason reaches the threshold, naming that reason", async () => {
    const reached = await ok("dana", "suggest-close", { id, reason: "not_reproducible", ...evidence("Five runs on main, requests req_b1 to req_b5: no flicker.") });
    expect(reached).toMatchObject({ reason: "not_reproducible", votes: 4, queued: true });
    const item = (await feedItem("dana", "close_issue", id)) as { title?: string } | undefined;
    expect(item?.title).toContain("not reproducible");
  });

  it("closes as not reproducible with the evidence, keeping the report", async () => {
    const closed = await ok("dana", "close-issue", { id, reason: "not_reproducible", evidence: "Five runs on main (req_b1 to req_b5) show no flicker." });
    expect(closed).toMatchObject({ status: "closed", closeReason: "not_reproducible", closeEvidence: "Five runs on main (req_b1 to req_b5) show no flicker." });
    const issue = (await ok("ada", "get-issue", { id })).issue;
    expect(issue).toMatchObject({ status: "closed", closeReason: "not_reproducible" });
    expect(issue.description).toBeTruthy();
  });

  it("refuses a working agent's reopen", async () => {
    await refused("bob", "reopen-issue", { id, evidence: "It flickers for me." }, 403);
  });

  it("is reopened by another manager with fresh evidence, back to Open", async () => {
    // eli is the sandbox's merger agent, which can do everything a manager can.
    const reopened = await ok("eli", "reopen-issue", { id, evidence: "Flickers again on main: request id req_c7, screen recording attached." });
    expect(reopened).toMatchObject({ issueId: id, status: "open", previousReason: "not_reproducible" });
    expect((await ok("ada", "get-issue", { id })).issue).toMatchObject({ status: "open", closeReason: null, closeEvidence: null });
  });

  it("refuses to reopen an issue that is not closed as not reproducible", async () => {
    expect(await refused("eli", "reopen-issue", { id, evidence: "Again." }, 409)).toMatchObject({ error: "not_reopenable" });
  });
});

describe("a duplicate names the issue that owns the work", () => {
  let id: string;
  let owner: string;
  let ownerNumber: number;

  beforeAll(async () => {
    owner = await fileIssue("ada", "CLI close reasons: CSV export drops the last row", ["bob", "cara", "eli"]);
    id = await fileIssue("ada", "CLI close reasons: exported CSV is missing a row", ["bob", "cara", "eli"]);
    ownerNumber = (await ok("ada", "get-issue", { id: owner })).issue.number;
  });

  it("refuses a duplicate suggestion without the other issue", async () => {
    await refused("bob", "suggest-close", { id, reason: "duplicate", ...evidence("Same bug as the CSV export one.") }, 422);
  });

  it("refuses a manager's duplicate close without the other issue", async () => {
    await ok("dana", "suggest-close", { id, reason: "duplicate", duplicateOf: ownerNumber, ...evidence(`#${ownerNumber} reports the same dropped row.`) });
    await refused("dana", "close-issue", { id, reason: "duplicate", evidence: "Same bug." }, 422);
  });

  it("closes it as a duplicate of the other issue", async () => {
    const closed = await ok("dana", "close-issue", { id, reason: "duplicate", duplicateOf: ownerNumber, evidence: `#${ownerNumber} owns the dropped-row fix.` });
    expect(closed).toMatchObject({ status: "closed", closeReason: "duplicate", duplicateOfId: owner });
  });
});

describe("the owner withdraws an issue", () => {
  let id: string;

  beforeAll(async () => {
    id = await fileIssue("ada", "CLI close reasons: a dark mode toggle in the footer", ["bob", "cara", "eli"]);
  });

  it("refuses anyone but the reporter or the person it is for", async () => {
    expect(await refused("bob", "withdraw-issue", { id }, 403)).toMatchObject({ error: "not_issue_owner" });
    expect(await refused("dana", "withdraw-issue", { id }, 403)).toMatchObject({ error: "not_issue_owner" });
  });

  it("closes it as withdrawn for its owner, without votes", async () => {
    const withdrawn = await ok("ada", "withdraw-issue", { id, evidence: "The header toggle covers it." });
    expect(withdrawn).toMatchObject({ issueId: id, status: "closed", closeReason: "withdrawn", closeEvidence: "The header toggle covers it." });
    expect((await ok("bob", "get-issue", { id })).issue).toMatchObject({ status: "closed", closeReason: "withdrawn" });
  });

  it("can't withdraw it twice", async () => {
    expect(await refused("ada", "withdraw-issue", { id }, 409)).toMatchObject({ error: "already_closed" });
  });
});
