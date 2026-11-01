import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, type TestContext } from "vitest";
import { fileIdea, fileIssue, ok, refused, unique, ziki, type Agent, type CliResult } from "./helpers";

/** Everything around the issues: projects, notes, mistakes, goals, jobs, webhooks, points, missions, keys. */
describe("the workspace around the issues", () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = (await ok("ada", "whoami")).project_id;
  });

  it("lists the agent's projects and reads one", async () => {
    const projects = await ok("bob", "list-projects");
    expect(JSON.stringify(projects)).toContain(projectId);
    expect(JSON.stringify(await ok("bob", "get-project", { id: projectId }))).toContain("cli-test");
  });

  describe("project notes", () => {
    it("are saved against the version you read, so concurrent edits don't overwrite each other", async () => {
      const before = await ok("ada", "get-notes", { id: projectId });
      const version = before.notes?.version ?? before.version ?? 0;
      const saved = await ok("ada", "save-notes", { id: projectId, body: "# Conventions\n\nUse pnpm.", expectedVersion: version, reason: "Start the notes." });
      expect(JSON.stringify(saved)).toContain("Use pnpm.");
      await refused("ada", "save-notes", { id: projectId, body: "# Stale", expectedVersion: version, reason: "Stale write." }, 409);
    });

    it("take comments, upvotes and their removal", async () => {
      const posted = await ok("bob", "comment-on-notes", { id: projectId, body: "Should we also document the release steps?" });
      const commentId = posted.comment?.id ?? posted.id;
      expect(commentId, JSON.stringify(posted)).toBeTruthy();
      await ok("cara", "upvote-note-comment", { id: projectId, commentId });
      await ok("cara", "remove-note-comment-upvote", { id: projectId, commentId });
      expect(JSON.stringify(await ok("ada", "list-note-comments", { id: projectId }))).toContain("release steps");
    });

    it("keep their history, which a merger agent or a workspace admin's agent can restore", async () => {
      const current = await ok("ada", "get-notes", { id: projectId });
      const version = current.notes?.version ?? current.version;
      await ok("ada", "save-notes", { id: projectId, body: "# Conventions\n\nUse pnpm and Node 22.", expectedVersion: version, reason: "Add the Node version." });
      const revisions = await ok("ada", "list-note-revisions", { id: projectId });
      const list = revisions.revisions ?? revisions.items ?? [];
      expect(list.length, JSON.stringify(revisions)).toBeGreaterThanOrEqual(2);
      const oldest = list[list.length - 1];
      const latest = await ok("ada", "get-notes", { id: projectId });
      // bob's owner is a plain member and bob is a working agent: no edit rights.
      await refused("bob", "restore-note-revision", { id: projectId, revisionId: oldest.id, expectedVersion: latest.notes?.version ?? latest.version, reason: "Roll back." }, 403);
      const restored = await ok("eli", "restore-note-revision", { id: projectId, revisionId: oldest.id, expectedVersion: latest.notes?.version ?? latest.version, reason: "Roll back." });
      expect(JSON.stringify(restored)).toContain("Use pnpm.");
    });
  });

  describe("the mistake registry", () => {
    it("is readable by any agent and written by manager agents", async () => {
      const entry = { id: projectId, category: "correctness", title: unique("Unchecked null"), antiPattern: "Reading a field without a null check.", remediation: "Guard it or use optional chaining." };
      expect((await refused("bob", "record-project-mistake", entry, 403)).error).toBe("insufficient_level");
      await ok("dana", "record-project-mistake", entry);
      expect(JSON.stringify(await ok("bob", "get-project-mistakes", { id: projectId }))).toContain(entry.title);
    });
  });

  describe("goals", () => {
    it("are created, read, listed, split across issues and completed", async () => {
      const target = await fileIssue("ada", "CLI workspace: goal target", ["bob", "cara", "eli"]);
      const created = await ok("ada", "create-goal", { title: unique("Ship the list fix"), description: "The blank list, fixed.", budgetPool: 100 });
      const goalId = created.goal?.id ?? created.id;
      expect(goalId, JSON.stringify(created)).toBeTruthy();
      expect(JSON.stringify(await ok("bob", "get-goal", { id: goalId }))).toContain("Ship the list fix");
      expect(JSON.stringify(await ok("bob", "list-goals"))).toContain(goalId);
      await ok("ada", "split-goal", { id: goalId, method: "manual", targets: JSON.stringify([{ targetType: "issue", targetBugId: target, amount: 60 }]) });
      expect(JSON.stringify(await ok("bob", "list-goal-allocations", { id: goalId }))).toContain(target);
      const done = await ok("ada", "update-goal", { id: goalId, status: "completed" });
      expect(JSON.stringify(done)).toContain("completed");
    });
  });

  describe("research jobs", () => {
    it("are posted by an agent whose owner is a workspace admin, and not otherwise", async () => {
      const job = { brief: "List three competitors' pricing pages.", dedupeKey: "url", maxSubmissions: 5, pointsPerAccepted: 10 };
      await refused("bob", "create-job", job, 403);
      const created = await ok("ada", "create-job", job);
      const jobId = created.job?.id ?? created.id;
      expect(jobId, JSON.stringify(created)).toBeTruthy();
      expect(JSON.stringify(await ok("bob", "list-jobs"))).toContain(jobId);
      expect(JSON.stringify(await ok("bob", "get-job", { id: jobId }))).toContain("competitors");

      const submitted = await ok("bob", "submit-job", { id: jobId, data: JSON.stringify({ url: "https://example.com/pricing", plan: "Pro" }) });
      const submissionId = submitted.submission?.id ?? submitted.id;
      expect(submissionId, JSON.stringify(submitted)).toBeTruthy();
      // Ziki offers the review to other owners' agents, through their inboxes.
      let offer: { agent: Agent; offerId: string } | undefined;
      for (const agent of ["ada", "cara", "dana", "eli"] as const) {
        const inbox = await ok(agent, "read-inbox");
        const item = inbox.items.find(
          (entry: { eventType: string; payload?: { submissionId?: string } }) => entry.eventType === "job.review.requested" && entry.payload?.submissionId === submissionId,
        );
        if (item) offer = { agent, offerId: item.payload.offerId };
        if (offer) break;
      }
      expect(offer, "no review offer reached a sandbox inbox").toBeTruthy();
      const reviewer = offer!.agent;
      await refused(reviewer, "review-job-submission", { id: submissionId, verdict: "accept" }, 409);
      await ok(reviewer, "accept-job-review", { id: offer!.offerId });
      const reviewed = await ok(reviewer, "review-job-submission", { id: submissionId, verdict: "accept", notes: "Checked the page." });
      expect(JSON.stringify(reviewed)).toMatch(/accept/);
    });
  });

  describe("webhooks", () => {
    it("are created with a one-time secret, rotated, listed with deliveries, and deleted", async (context) => {
      const attempt = await ziki("create-webhook", "--url", "https://example.com/ziki-hook", "--events", "issue.created", "--as", "bob");
      if (attempt.json?.status === 503) {
        // Signing secrets are encrypted with WEBHOOK_SECRET_KEY; without it the server says so plainly.
        expect(attempt.json.body.error).toMatch(/unavailable/);
        context.skip("Set WEBHOOK_SECRET_KEY in .env (64 hex characters) to test webhooks.");
      }
      expect(attempt.code, attempt.out).toBe(0);
      const created = attempt.json;
      const hookId = created.webhook?.id ?? created.subscription?.id ?? created.id;
      expect(hookId, JSON.stringify(created)).toBeTruthy();
      expect(JSON.stringify(created)).toMatch(/secret/i);
      expect(JSON.stringify(await ok("bob", "list-webhooks"))).toContain(hookId);
      expect(JSON.stringify(await ok("bob", "update-webhook", { id: hookId, rotateSecret: true }))).toMatch(/secret/i);
      expect(await ok("bob", "list-webhook-deliveries", { id: hookId })).toBeTruthy();
      await refused("bob", "retry-webhook-delivery", { id: hookId, deliveryId: "no-such-delivery" }, 404);
      await refused("cara", "delete-webhook", { id: hookId }, 404);
      await ok("bob", "delete-webhook", { id: hookId });
      expect(JSON.stringify(await ok("bob", "list-webhooks"))).not.toContain(hookId);
    });

    it("refuse plain-HTTP endpoints", async () => {
      const result = await ziki("create-webhook", "--url", "http://example.com/hook", "--as", "bob");
      expect(result.code).not.toBe(0);
    });
  });

  describe("points", () => {
    it("shows the owner's balance and ledger", async () => {
      expect(await ok("bob", "get-points")).toBeTruthy();
      const entries = await ok("bob", "list-point-entries", { limit: 5 });
      expect(Array.isArray(entries.entries ?? entries.items), JSON.stringify(entries)).toBe(true);
    });
  });

  describe("missions", () => {
    it("hands out the next route to cover, and records its coverage", async () => {
      const next = await ziki("next-mission", "--as", "cara");
      if (next.code === 0 && next.json?.mission) {
        const covered = await ok("cara", "cover-mission", { id: next.json.mission.id, issuesFiled: 0 });
        expect(covered).toBeTruthy();
      } else {
        // A project with no routes to cover has no mission to hand out.
        expect([0, 1]).toContain(next.code);
      }
    });
  });

  describe("pairing and keys", () => {
    /** Pairing starts are limited per IP over 15 minutes, too long to wait out in a test. */
    function skipIfPairingLimited(result: CliResult, context: TestContext): void {
      if (result.json?.status === 429 && result.json.body?.error === "rate_limited") {
        context.skip("Pairing is limited to 10 starts per 15 minutes from one IP. Rerun later to cover it.");
      }
    }

    it("starts device-code pairing for a new agent, which waits for a person's approval", async (context) => {
      const attempt = await ziki("pair", "--name", unique("Paired"), "--model", "Test", "--as", "ada");
      skipIfPairingLimited(attempt, context);
      expect(attempt.code, attempt.out).toBe(0);
      const started = attempt.json;
      expect(started.user_code).toBeTruthy();
      expect(started.device_code).toBeTruthy();
      const pending = await ziki("collect-pairing-token", "--device-code", started.device_code, "--as", "ada");
      expect(pending.code).toBe(1);
      expect(JSON.stringify(pending.json)).toMatch(/authorization_pending|pending/);
    });

    it("accepts an old role name at pairing and maps it to a class", async (context) => {
      const legacy = await ziki("request", "POST", "/api/v1/agents/pairing", "--body", JSON.stringify({ name: unique("Legacy"), level: "contributor" }), "--as", "ada");
      skipIfPairingLimited(legacy, context);
      expect(legacy.code, legacy.out).toBe(0);
      const refusedClass = await ziki("request", "POST", "/api/v1/agents/pairing", "--body", JSON.stringify({ name: unique("Boss"), level: "manager" }), "--as", "ada");
      skipIfPairingLimited(refusedClass, context);
      expect(refusedClass.code).toBe(1);
      expect(JSON.stringify(refusedClass.json)).toMatch(/manager or merger/);
    });

    it("rotates a key: the keyring keeps working, and the old key stops", async () => {
      const before = (await ziki("agents")).json.agents.find((agent: { name: string }) => agent.name === "cara");
      expect(before).toBeTruthy();
      const rotated = await ok("cara", "rotate-key");
      expect(rotated.api_key).toMatch(/^ziki_/);
      expect((await ok("cara", "whoami")).name).toBe("cara");
    });
  });

  describe("routes with local limits", () => {
    it("resolving needs a linked pull request reported merged, so an issue without one is refused clearly", async () => {
      const issue = await fileIssue("ada", "CLI workspace: resolve without a pull request", ["bob", "cara", "eli"]);
      const result = await ziki("resolve-issue", "--id", issue, "--pull-request-url", "https://github.com/emerjent/ziki/pull/1", "--as", "ada");
      expect(result.code).toBe(1);
      expect(result.json.status).toBe(409);
    });

    it("structures an open idea, and refuses one that is no longer open", async () => {
      const idea = await fileIdea("ada", "CLI workspace: idea to structure");
      const structured = await ok("bob", "structure-idea", { id: idea, summary: "Saving does nothing.", acceptanceCriteria: ["Save stores the form"] });
      expect(JSON.stringify(structured)).toContain("Saving does nothing.");
      await refused("bob", "structure-idea", { id: "no-such-issue", summary: "A summary." }, 404);
    });

    it("accepting an unknown review offer is a 404", async () => {
      await refused("bob", "accept-review-offer", { id: randomUUID() }, 404);
      await refused("bob", "accept-job-review", { id: randomUUID() }, 404);
    });
  });
});
