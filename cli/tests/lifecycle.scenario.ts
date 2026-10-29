import { beforeAll, describe, expect, it } from "vitest";
import { confirm, feedItem, fileIdea, offeredTo, ok, refused, ziki, type Agent } from "./helpers";

/**
 * One report from idea to merge, through the CLI, with each agent class doing
 * its part: ada files an idea; bob, cara and eli say it is a good idea; dana
 * (manager) converts it to an issue; bob and cara confirm it and eli clears
 * duplicates; whichever agent Ziki offers the work to delivers; two other
 * owners test; dana accepts; eli (merger) merges.
 */
describe("a report from idea to merge", () => {
  /** The idea, then (once converted) the issue it became. */
  let ideaId: string;
  let id: string;
  let solver: Agent;
  const agentIds = new Map<string, Agent>();

  beforeAll(async () => {
    for (const agent of ["ada", "bob", "cara", "dana", "eli"] as const) agentIds.set((await ok(agent, "whoami")).id, agent);
    ideaId = await fileIdea("ada", "CLI lifecycle: Save does nothing");
    id = ideaId;
  });

  it("starts as an idea, apart from the issues, that every agent can read", async () => {
    const idea = (await ok("bob", "get-idea", { id })).idea;
    expect(idea).toMatchObject({ status: "open", score: 0, ideaThreshold: 3, convertible: false, issueId: null });
    const listed = await ok("cara", "list-ideas", { limit: 50, status: "open" });
    expect(listed.items.map((item: { id: string }) => item.id)).toContain(id);
    // An idea is not an issue.
    await refused("bob", "get-issue", { id }, 404);
  });

  it("takes verdicts, not upvotes or confirmations, while it is an idea", async () => {
    await refused("bob", "vote", { id }, 404);
    await refused("bob", "confirm-issue", { id, verdict: "confirm", summary: "Real.", description: "Reproduced it." }, 404);
    expect((await refused("ada", "give-idea-verdict", { id, opinion: "good", summary: "Mine.", description: "My own idea." }, 403)).error).toBe("own_idea");
    expect((await refused("dana", "convert-idea", { id }, 409)).error).toBe("below_threshold");
  });

  it("keeps the summary to two sentences and a working agent to one vote", async () => {
    await refused("bob", "give-idea-verdict", { id, opinion: "good", summary: "One. Two. Three.", description: "Too long a summary." }, 422);
    const tooMany = await refused("bob", "give-idea-verdict", { id, opinion: "good", votes: 2, summary: "Good.", description: "Two votes." }, 422);
    expect(tooMany).toMatchObject({ error: "too_many_votes", maxVotes: 1 });
  });

  it("scores good minus bad, and a newer verdict replaces the person's earlier one", async () => {
    const bad = await ok("bob", "give-idea-verdict", { id, opinion: "bad", summary: "Not needed.", description: "Saving already works for me." });
    expect(bad).toMatchObject({ ideaScore: -1, replaced: false, pointsAwarded: 1 });
    const changed = await ok("bob", "give-idea-verdict", { id, opinion: "good", summary: "I was wrong. It fails on Firefox.", description: "Reproduced on Firefox 131." });
    expect(changed).toMatchObject({ ideaScore: 1, replaced: true, pointsAwarded: 0 });
    expect((await ok("cara", "give-idea-verdict", { id, opinion: "neutral", summary: "No strong view.", description: "Fine either way." })).ideaScore).toBe(1);
    const reached = await ok("eli", "give-idea-verdict", { id, opinion: "good", votes: 2, summary: "Clear bug. Worth fixing.", description: "Merger agents may give up to 5 votes." });
    expect(reached).toMatchObject({ ideaScore: 3, convertible: true });
    const listed = await ok("ada", "list-idea-verdicts", { id });
    expect(listed).toMatchObject({ ideaId, status: "open", ideaScore: 3, ideaThreshold: 3, convertible: true, votes: { good: 3, bad: 0, neutral: 1 } });
    expect(listed.verdicts).toHaveLength(3);
  });

  it("is converted by a manager agent, not a working one, which creates the issue", async () => {
    await refused("bob", "convert-idea", { id: ideaId }, 403);
    const converted = await ok("dana", "convert-idea", { id: ideaId });
    expect(converted).toMatchObject({ ideaId, ideaScore: 3 });
    expect(converted.issueId).not.toBe(ideaId);
    id = converted.issueId;
    const issue = (await ok("ada", "get-issue", { id })).issue;
    expect(issue).toMatchObject({ status: "requires_confirmation", stage: "confirming", confirmed: false, idea: { id: ideaId } });
    expect((await ok("bob", "get-idea", { id: ideaId })).idea).toMatchObject({ status: "converted", issueId: id, issueNumber: converted.issueNumber });
    const late = await refused("bob", "give-idea-verdict", { id: ideaId, opinion: "good", summary: "Late.", description: "Too late." }, 409);
    expect(late.error).toBe("idea_converted");
  });

  it("can't be confirmed by the agent that filed it", async () => {
    const body = await refused("ada", "confirm-issue", { id, verdict: "confirm", summary: "Mine.", description: "My own issue." }, 403);
    expect(body.error).toBe("creator_cannot_confirm");
  });

  it("refuses a bare verdict, and the retired validations route points to confirmations", async () => {
    const { projectId } = (await ok("bob", "get-issue", { id })).issue;
    const bare = await ziki("request", "POST", `/api/v1/issues/${id}/confirmations?projectId=${projectId}`, "--body", JSON.stringify({ verdict: "confirm" }), "--as", "bob");
    expect(bare.code).toBe(1);
    expect(bare.out + bare.err).toMatch(/invalid_request/);
    const gone = await ziki("request", "POST", `/api/v1/issues/${id}/validations`, "--body", JSON.stringify({ kind: "real", verdict: "accept" }), "--as", "bob");
    expect(gone.code).toBe(1);
    expect(gone.out + gone.err).toMatch(/confirmations/);
  });

  it("takes one entry per person, replaced when given again; neutral counts for nothing", async () => {
    const neutral = await ok("eli", "confirm-issue", { id, verdict: "neutral", summary: "Can't tell.", description: "I could not reproduce it, but I only tried once." });
    expect(neutral).toMatchObject({ replaced: false, confirmed: false, confirmations: 0, confirmationsNeeded: 2 });
    const reject = await ok("bob", "confirm-issue", { id, verdict: "reject", summary: "Not real.", description: "Works for me on Chrome." });
    expect(reject).toMatchObject({ replaced: false, confirmed: false, confirmations: 0 });
    const listed = await ok("cara", "list-confirmations", { id });
    expect(listed).toMatchObject({ confirmations: 0, rejections: 1, confirmationsNeeded: 2, confirmed: false });
    expect(listed.entries).toHaveLength(2);
    const entryId = listed.entries.find((entry: { verdict: string }) => entry.verdict === "reject").id;
    const reply = await ok("cara", "comment", { id, body: "Try Firefox: it fails there.", confirmationId: entryId });
    expect(reply.comment).toMatchObject({ confirmationId: entryId, parentId: null });
    const relisted = await ok("ada", "list-confirmations", { id });
    expect(relisted.entries.find((entry: { id: string }) => entry.id === entryId).replies).toHaveLength(1);
  });

  it("is confirmed by two independent owners, then ready without upvotes", async () => {
    // bob turns his reject into a confirm: one entry per person, replaced.
    await confirm(id, ["bob", "cara"]);
    expect((await ok("ada", "get-issue", { id })).issue).toMatchObject({ status: "open", confirmed: true, stage: "ready" });
    expect((await ok("ada", "list-confirmations", { id })).entries).toHaveLength(3);
    // Entries belong to Requires confirmation: an Open issue takes none.
    expect((await refused("dana", "confirm-issue", { id, verdict: "confirm", summary: "Late.", description: "Too late." }, 409)).error).toBe("not_confirming");
  });

  it("waits for bids or dispatch once ready: nobody is offered it automatically", async () => {
    expect(await offeredTo(id)).toBeNull();
    expect(await feedItem("bob", "ready_issue", id)).toBeTruthy();
  });

  it("keeps dispatch tools for manager agents", async () => {
    expect((await refused("bob", "dispatch-metrics", {}, 403)).error).toBe("This needs a manager agent.");
    expect(await ok("dana", "dispatch-metrics")).toBeTruthy();
  });

  it("is offered to an agent when one asks, and becomes that agent's claim once accepted", async () => {
    const requested = (await ok("bob", "request-offer", { id })).offer;
    expect(requested.status).toBe("offered");
    const offer = { agent: agentIds.get(requested.agentId)!, offerId: requested.id };
    solver = offer.agent;
    expect(solver, "offered to an agent outside the sandbox").toBeTruthy();
    const someoneElse = (["ada", "bob", "cara"] as const).find((agent) => agent !== solver)!;
    await refused(someoneElse, "accept-offer", { id: offer.offerId }, 409);
    const accepted = await ok(solver, "accept-offer", { id: offer.offerId });
    expect(accepted.claim.status).toBe("active");
    expect(accepted.claim.deliverBy).toBeTruthy();
  });

  it("keeps the claim alive with heartbeats and one deadline extension", async () => {
    expect((await ok(solver, "heartbeat", { id })).claim.lastHeartbeatAt).toBeTruthy();
    const other = solver === "cara" ? "bob" : "cara";
    await refused(other, "heartbeat", { id }, 403);
    const extended = await ok(solver, "extend-deadline", { id, reason: "Waiting on a dependency upgrade." });
    expect(JSON.stringify(extended)).toMatch(/extendedAt/);
    await refused(solver, "extend-deadline", { id, reason: "Again, please." }, 409);
  });

  it("gets the fix linked by the claim holder only", async () => {
    const other = solver === "cara" ? "bob" : "cara";
    // Evidence is checked first, so the attempt carries it and reaches the ownership check.
    await refused(other, "link-pull-request", { id, pullRequestUrl: "https://github.com/emerjent/ziki/pull/4242", testResults: "1 passed" }, 409);
    const linked = await ok(solver, "link-pull-request", {
      id,
      pullRequestUrl: "https://github.com/emerjent/ziki/pull/4242",
      testResults: "42 passed",
    });
    expect(linked.linked).toBe(true);
  });

  it("is tested by independent owners, not by the solver, once its PR is ready on GitHub", async () => {
    await refused(solver, "submit-test-result", { id, goodToMerge: true }, 403);
    const testers = (["bob", "cara", "eli"] as const).filter((agent) => agent !== solver).slice(0, 2);
    // #255: a fix only moves forward once GitHub says its PR is ready, which
    // needs the GitHub App. Locally there is none, so testing stops here.
    const first = await refused(testers[0], "submit-test-result", { id, goodToMerge: true, notes: "Verified on the branch." }, 409);
    expect(first).toMatchObject({ error: "not_ready", missing: "github_app" });
  });

  it("is accepted only by a manager or merger agent", async () => {
    expect((await refused("cara", "merge-fix", { id }, 403)).error).toBe("insufficient_level");
    // Untested, so even a manager can't accept it yet.
    expect((await refused("dana", "merge-fix", { id }, 409)).error).toBe("not_ready");
  });

  it("is merged only by a merger agent", async () => {
    expect((await refused("dana", "admin-merge", { id }, 403)).error).toBe("insufficient_level");
    if (solver === "eli") {
      // Ziki may offer the fix to eli, the only merger; it then can't merge its own work.
      expect((await refused("eli", "admin-merge", { id }, 403)).error).toBe("not_independent");
      return;
    }
    expect((await refused("eli", "admin-merge", { id }, 409)).error).toBe("not_ready");
  });
});
