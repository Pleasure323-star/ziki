import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { confirm, feedItem, fileIssue, offeredTo, ok, refused, unique, ziki } from "./helpers";

/** Talking about an issue and lining up work on it, through the CLI. */
describe("working on issues together", () => {
  let id: string;

  beforeAll(async () => {
    // Comments are for issues; ideas take only verdicts.
    id = await fileIssue("cara", "CLI collaboration: list goes blank", ["ada", "bob", "eli"]);
  });

  it("threads comments and replies, readable newest-first and from the start", async () => {
    const first = await ok("bob", "comment", { id, body: "I can reproduce this on Firefox." });
    const commentId = first.comment?.id ?? first.id;
    expect(commentId, JSON.stringify(first)).toBeTruthy();
    await ok("dana", "comment", { id, body: "Same here, after the last deploy.", parentId: commentId });
    const latest = await ok("ada", "list-comments", { id });
    expect(JSON.stringify(latest)).toContain("I can reproduce this on Firefox.");
    const fromStart = await ok("ada", "list-comments-from-start", { id });
    expect(JSON.stringify(fromStart)).toContain("Same here, after the last deploy.");
  });

  it("files a structured delivery-type comment with metadata", async () => {
    const posted = await ok("bob", "comment", {
      id,
      body: "Root cause found in the list query.",
      type: "review",
      metadata: JSON.stringify({ confidence: 80, confidenceReason: "Reproduced locally." }),
    });
    expect(JSON.stringify(posted)).toContain("Root cause found");
  });

  it("waits for confirmation before taking bids", async () => {
    await refused("bob", "volunteer", { id, summary: "Too early.", description: "Not confirmed yet." }, 409);
  });

  it("takes bids once the issue is ready (converted and confirmed): summary and description required, a new bid replaces, replies and withdraw work", async () => {
    await confirm(id, ["ada", "bob"]);
    // A confirmed issue is not offered automatically, so it is open to bids.
    expect(await offeredTo(id)).toBeNull();
    // A bare bid is refused: every entry explains itself. The retired interest route points to bids.
    const { projectId } = (await ok("eli", "get-issue", { id })).issue;
    const bare = await ziki("request", "POST", `/api/v1/issues/${id}/bid?projectId=${projectId}`, "--body", JSON.stringify({ note: "I can fix this today." }), "--as", "eli");
    expect(bare.code).toBe(1);
    expect(bare.json?.status).toBe(400);
    expect(bare.out + bare.err).toMatch(/summary/);
    const gone = await ziki("request", "POST", `/api/v1/issues/${id}/interest?projectId=${projectId}`, "--body", JSON.stringify({ note: "Happy to take this." }), "--as", "bob");
    expect(gone.code).toBe(1);
    expect(gone.json?.status).toBe(410);
    expect(gone.out + gone.err).toMatch(/\/bid/);
    const bid = await ok("eli", "volunteer", { id, summary: "I can fix this today.", description: "The list query drops rows after a deploy; I will fix the cache key and add a test." });
    expect(bid.bid_id).toBeTruthy();
    expect(bid.replaced).toBe(false);
    // Bidding again replaces the same bid.
    const again = await ok("eli", "volunteer", { id, summary: "I can fix this within the hour.", description: "Same plan, sooner." });
    expect(again).toMatchObject({ bid_id: bid.bid_id, replaced: true, summary: "I can fix this within the hour." });
    const reply = await ok("cara", "comment", { id, body: "Please include a regression test.", bidId: bid.bid_id });
    expect(reply.comment).toMatchObject({ bidId: bid.bid_id, parentId: null });
    const listed = JSON.stringify(await ok("cara", "list-bids", { id }));
    expect(listed).toContain(bid.bid_id);
    expect(listed).toContain("I can fix this within the hour.");
    expect(listed).toContain("Please include a regression test.");
    await ok("eli", "withdraw-bid", { id });
    expect(JSON.stringify(await ok("cara", "list-bids", { id }))).not.toContain(bid.bid_id);
  });

  it("says direct claiming is retired and points to offers and bids", async () => {
    await refused("bob", "claim-issue", { id }, 410);
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
