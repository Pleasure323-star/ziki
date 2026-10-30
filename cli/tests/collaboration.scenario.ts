import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { confirm, feedItem, fileIssue, offeredTo, ok, refused, unique, ziki } from "./helpers";

/** Talking about an issue and lining up work on it, through the CLI. */
describe("working on issues together", () => {
  let id: string;

  beforeAll(async () => {
    // Replies are for issue entries; ideas take only verdicts.
    id = await fileIssue("cara", "CLI collaboration: list goes blank", ["ada", "bob", "eli"]);
  });

  it("takes no comment on the issue itself before it is Open: the 409 names the stage's entry route", async () => {
    const body = await refused("bob", "comment", { id, body: "I can reproduce this on Firefox." }, 409);
    expect(body.error).toBe("use_stage_entry");
    // A new issue requires confirmation, so the entry is a confirmation.
    expect(body.entryRoute).toMatch(/\/confirmations$/);
    expect(body.message).toMatch(/only while it is Open/);
  });

  it("refuses typed comments and metadata with a 400 that lists the entry routes", async () => {
    const { projectId } = (await ok("ada", "get-issue", { id })).issue;
    const typed = await ziki(
      "request", "POST", `/api/v1/issues/${id}/comments?projectId=${projectId}`,
      "--body", JSON.stringify({ body: "Root cause found in the list query.", type: "review", metadata: { confidence: 80 } }),
      "--as", "bob",
    );
    expect(typed.code).toBe(1);
    expect(typed.json?.status).toBe(400);
    expect(typed.out + typed.err).toMatch(/comment_has_no_type/);
    expect(typed.out + typed.err).toMatch(/test-results/);
  });

  it("waits for confirmation before taking bids", async () => {
    await refused("bob", "bid", { id, summary: "Too early.", description: "Not confirmed yet." }, 409);
  });

  it("takes bids once the issue is ready (converted and confirmed): summary and description required, a new bid replaces, replies and withdraw work", async () => {
    await confirm(id, ["ada", "bob"]);
    // A confirmed issue is not offered automatically, so it is open to bids.
    expect(await offeredTo(id)).toBeNull();
    // A bare bid is refused: every entry explains itself.
    const { projectId } = (await ok("eli", "get-issue", { id })).issue;
    const bare = await ziki("request", "POST", `/api/v1/issues/${id}/bid?projectId=${projectId}`, "--body", JSON.stringify({}), "--as", "eli");
    expect(bare.code).toBe(1);
    expect(bare.json?.status).toBe(400);
    expect(bare.out + bare.err).toMatch(/summary/);
    const bid = await ok("eli", "bid", { id, summary: "I can fix this today.", description: "The list query drops rows after a deploy; I will fix the cache key and add a test." });
    expect(bid.bid_id).toBeTruthy();
    expect(bid.replaced).toBe(false);
    // Bidding again replaces the same bid.
    const again = await ok("eli", "bid", { id, summary: "I can fix this within the hour.", description: "Same plan, sooner." });
    expect(again).toMatchObject({ bid_id: bid.bid_id, replaced: true, summary: "I can fix this within the hour." });
    const reply = await ok("cara", "comment", { id, body: "Please include a regression test.", bidId: bid.bid_id });
    expect(reply.comment).toMatchObject({ bidId: bid.bid_id, parentId: null });
    // Replies read newest-first and from the start, like any comment.
    expect(JSON.stringify(await ok("ada", "list-comments", { id }))).toContain("Please include a regression test.");
    expect(JSON.stringify(await ok("ada", "list-comments-from-start", { id }))).toContain("Please include a regression test.");
    const listed = JSON.stringify(await ok("cara", "list-bids", { id }));
    expect(listed).toContain(bid.bid_id);
    expect(listed).toContain("I can fix this within the hour.");
    expect(listed).toContain("Please include a regression test.");
    await ok("eli", "withdraw-bid", { id });
    expect(JSON.stringify(await ok("cara", "list-bids", { id }))).not.toContain(bid.bid_id);
  });

  it("takes comments on the issue itself while it is Open, and one-level replies to them", async () => {
    const { comment } = await ok("bob", "comment", { id, body: "Still blank on Firefox 131 after the deploy." });
    expect(comment).toMatchObject({ parentId: null, bidId: null, confirmationId: null });
    const { comment: reply } = await ok("cara", "comment", { id, body: "Thanks, that narrows it down.", parentId: comment.id });
    expect(reply.parentId).toBe(comment.id);
    // Replies are one level deep.
    await refused("ada", "comment", { id, body: "Me too.", parentId: reply.id }, 422);
    // One place per comment.
    await refused("ada", "comment", { id, body: "Me too.", parentId: comment.id, confirmationId: "c0000000000000000000000000" }, 422);
  });

  it("releases a claim it no longer wants, so the issue can be offered again", async () => {
    const { offer } = await ok("bob", "request-offer", { id });
    const holder = (await Promise.all((["ada", "bob", "cara", "dana", "eli"] as const).map(async (agent) => [agent, (await ok(agent, "whoami")).id] as const))).find(
      ([, agentId]) => agentId === offer.agentId,
    )![0];
    await ok(holder, "accept-offer", { id: offer.id });
    const released = await ok(holder, "release-claim", { id, reason: "Out of time this week." });
    expect(released.claimId).toBe(offer.id);
  });

  it("asks the owner a question and reads it back", async () => {
    const asked = await ok("bob", "ask-owner", { body: "Should the fix also cover the mobile list?", bugId: id });
    const questionId = asked.question?.id ?? asked.id;
    expect(questionId, JSON.stringify(asked)).toBeTruthy();
    expect(JSON.stringify(await ok("bob", "get-question", { id: questionId }))).toContain("mobile list");
  });

  it("escalates a blocker and reads the escalation back", async () => {
    const escalated = await ok("bob", "escalate", { body: "Blocked: the staging database is down.", bugId: id, type: "blocker" });
    const escalationId = escalated.question?.id ?? escalated.escalation?.id ?? escalated.id;
    expect(escalationId, JSON.stringify(escalated)).toBeTruthy();
    expect(JSON.stringify(await ok("bob", "get-escalation", { id: escalationId }))).toContain("staging database");
  });

  it("reads the inbox and marks it read", async () => {
    const inbox = await ok("cara", "read-inbox");
    expect(Array.isArray(inbox.items), JSON.stringify(inbox)).toBe(true);
    const ids = (inbox.items as { id: string }[]).map((item) => item.id);
    if (ids.length) expect(await ok("cara", "mark-inbox-read", { ids })).toBeTruthy();
    const unread = await ok("cara", "read-inbox", { unread: true });
    expect((unread.items ?? []).length).toBe(0);
  });

  it("follows the project through the feed, polled events and the event stream", async () => {
    const feed = await ok("ada", "read-feed");
    expect(feed).toBeTruthy();
    const events = await ok("ada", "poll-events", { wait: 0 });
    expect(JSON.stringify(events)).toMatch(/issue\./);
    // The stream is server-sent events, printed as they arrived rather than JSON.
    const stream = await ziki("stream-events", "--seconds", "2", "--as", "ada");
    expect(stream.code).toBe(0);
  });

  it("lists a converted issue to confirm in the work feed, the one queue (#714)", async () => {
    // Ideas take verdicts; the feed lists the issue to confirm once converting creates it.
    const fresh = await fileIssue("ada", "CLI collaboration: needs confirming", ["bob", "cara", "eli"]);
    const item = await feedItem("bob", "confirm_issue", fresh);
    expect(item?.actions?.map((action) => action.name)).toEqual(["confirm_issue"]);
  });

  it("structures an agent's report, and marks a duplicate through structuring", async () => {
    const draft = await fileIssue("ada", "CLI collaboration: draft to structure", ["bob", "cara", "eli"]);
    const structured = await ok("bob", "structure-issue", {
      id: draft,
      stepsToReproduce: "1. Open the list. 2. Scroll.",
      expectedBehavior: "Rows stay visible.",
      actualBehavior: "The list goes blank.",
    });
    expect(JSON.stringify(structured)).toMatch(/Rows stay visible|structured|issue/);
    const duplicate = await fileIssue("ada", "CLI collaboration: the same blank list", ["bob", "cara", "eli"]);
    const marked = await ok("bob", "structure-issue", { id: duplicate, duplicateOfId: id });
    expect(JSON.stringify(marked)).toContain(id);
  });

  it("proposes a redesign for a person to decide", async () => {
    const proposed = await ok("bob", "propose-redesign", {
      bugId: id,
      title: unique("Redesign the list"),
      body: "Use a virtualised list so long pages stay fast.",
    });
    expect(JSON.stringify(proposed)).toMatch(/proposed|redesign/i);
  });

  it("uploads an attachment and files an idea with it", async () => {
    // A 1×1 transparent PNG.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const uploaded = await ok("ada", "upload-attachment", { filename: "screenshot.png", dataBase64: png });
    const attachmentId = uploaded.attachment?.id ?? uploaded.id;
    expect(attachmentId, JSON.stringify(uploaded)).toBeTruthy();
    const created = await ok("ada", "create-idea", {
      title: unique("CLI collaboration: with a screenshot"),
      description: "Steps: open it. Expected: it works. Actual: see the screenshot.",
      attachmentIds: [attachmentId],
      acknowledgeSimilar: true,
    });
    expect(JSON.stringify(created.idea.attachments)).toContain(attachmentId);
  });

  it("warns before filing a report like an open idea, and files it once acknowledged", async () => {
    const title = unique("CLI collaboration: duplicate check");
    const description = "Steps: open the page and press Save. Expected: it saves. Actual: nothing happens.";
    await ok("ada", "create-idea", { title, description, acknowledgeSimilar: true });
    const idempotencyKey = randomUUID();
    const warned = await refused("bob", "create-idea", { title, description, idempotencyKey }, 409);
    expect(warned.error).toBe("similar_issues");
    expect(warned.matches[0]).toMatchObject({ title, kind: "idea" });
    const filed = await ok("bob", "create-idea", { title, description, idempotencyKey, acknowledgeSimilar: true });
    expect(filed.idea.title).toBe(title);
  });
});
