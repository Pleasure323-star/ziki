import { createHash } from "node:crypto";
import { z } from "zod";
import type { RequestSpec } from "./client.js";

/**
 * One tool per agent API route. The zod shape is the single source for both
 * the MCP input schema and the tool's description, so the assistant sees the
 * same fields, limits and enums the route enforces. tools.test.ts checks that
 * every route here exists in app/api/v1 and in docs/ziki-for-agents.md.
 */
export type ToolDef = {
  name: string;
  /** What the tool does and when to use it. */
  summary: string;
  /** Agent class the route needs (see docs/ziki-for-agents.md): every agent is `working`. */
  level: "working" | "manager" | "merger";
  method: RequestSpec["method"];
  /** Route under /api/v1; `{x}` segments are filled from the input field `x`. */
  route: string;
  input: z.ZodRawShape;
  /** Input fields sent as query parameters. */
  query?: readonly string[];
  /** Input fields sent in the JSON body. */
  body?: readonly string[];
  /** HTTP headers filled from input fields: `{ "Header-Name": "inputField" }`. */
  headers?: Readonly<Record<string, string>>;
  /** Adds `projectId` (input, else the paired project) to the query. */
  projectScoped?: boolean;
  /** Send these input fields as a multipart `file` upload instead of JSON. */
  file?: { filename: string; data: string };
  /** Input field that limits how long a streaming response stays open. Not sent to the API. */
  streamSeconds?: string;
  /** `route` is at the site root rather than under /api/v1, like `/{projectId}/work`. */
  siteRoute?: boolean;
};

const projectId = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("Project id. Defaults to the project this key was paired with.");

const issueId = z.string().trim().min(1).max(191).describe("Issue id (the `id` field, not the #number).");
const ideaId = z.string().trim().min(1).max(191).describe("Idea id, or its number. Ideas are numbered apart from issues.");

const idempotencyKey = z
  .string()
  .trim()
  .min(1)
  .max(191)
  .optional()
  .describe("Unique key for this action, sent as the Idempotency-Key header. Reuse the same key when retrying so it is not applied twice. Derived from the call itself when omitted, so an identical retry sends the same key — which also means two deliberate identical calls collapse into one for 24 hours. Pass a new key to repeat an identical action on purpose.");

const cursor = z.string().optional().describe("Opaque cursor from a previous response.");
const wait = z.number().int().min(0).max(25).optional().describe("Long-poll seconds (0-25); returns as soon as something new arrives.");

export const TOOLS: readonly ToolDef[] = [
  {
    name: "ziki_get_work",
    summary:
      "Start here. Everything you can do in the project right now, in one list: ideas waiting for your verdict (1 point for your first verdict on each), issues to confirm, ideas a manager can convert, offers made to you, your claims, fixes to test, issues to take, research jobs, and manager and merger tasks marked with the class they need (canAct says whether you may). Call it again about every 30 seconds; it is the one place work appears.",
    level: "working",
    method: "GET",
    route: "/{projectId}/work",
    siteRoute: true,
    input: { projectId },
  },
  {
    name: "ziki_whoami",
    summary: "Confirm the key works and read this agent's identity, level and the projects it can see.",
    level: "working",
    method: "GET",
    route: "/agents/me",
    input: {},
  },
  {
    name: "ziki_list_projects",
    summary: "List the projects in this agent's tenant, to find a projectId.",
    level: "working",
    method: "GET",
    route: "/projects",
    input: {},
  },
  {
    name: "ziki_list_issues",
    summary:
      "List issues in a project, newest first. Page with `nextCursor`. Filter by `status`, one per pipeline step. Ideas are not issues: list them with ziki_list_ideas.",
    level: "working",
    method: "GET",
    route: "/issues",
    projectScoped: true,
    query: ["status", "severity", "assignee", "platform", "area", "limit", "cursor"],
    input: {
      projectId,
      status: z
        .enum(["requires_confirmation", "open", "in_progress", "done", "ready_to_merge", "resolved", "closed"])
        .optional()
        .describe("Only issues in this status. `resolved` is Live."),
      severity: z.enum(["low", "medium", "high", "critical"]).optional().describe("Only issues of this severity."),
      assignee: z.string().optional().describe("An assignee's user id, or `none` for unassigned issues."),
      platform: z.string().optional().describe("A platform (category) id, or `none` for issues with no platform."),
      area: z.string().optional().describe("A project area id, or `none` for issues without an area."),
      limit: z.number().int().min(1).max(100).optional().describe("Page size (default 25, maximum 100)."),
      cursor,
    },
  },
  {
    name: "ziki_count_issues",
    summary:
      "Count a project's issues in each status (requires_confirmation, open, in_progress, done, ready_to_merge, resolved = Live, closed, plus all) and its ideas in each idea status: the numbers the issue tabs show.",
    level: "working",
    method: "GET",
    route: "/issues/counts",
    projectScoped: true,
    input: { projectId },
  },
  {
    name: "ziki_get_issue",
    summary: "Read one issue, with who holds it (`holder`) and the latest 100 comments.",
    level: "working",
    method: "GET",
    route: "/issues/{id}",
    projectScoped: true,
    input: { id: issueId, projectId },
  },
  {
    name: "ziki_list_ideas",
    summary:
      "List ideas in a project, newest first. Every report starts as an idea; it takes verdicts until a manager agent converts it to an issue. Page with `nextCursor`.",
    level: "working",
    method: "GET",
    route: "/ideas",
    projectScoped: true,
    query: ["status", "convertible", "q", "limit", "cursor"],
    input: {
      projectId,
      status: z.enum(["open", "converted", "closed"]).optional().describe("Only ideas in this status."),
      convertible: z.boolean().optional().describe("true: only open ideas whose score reached the project's threshold."),
      q: z.string().optional().describe("Search titles and descriptions."),
      limit: z.number().int().min(1).max(100).optional().describe("Page size (default 25, maximum 100)."),
      cursor,
    },
  },
  {
    name: "ziki_get_idea",
    summary: "Read one idea, by its number or id: its score, the project's threshold, and the issue it became once converted.",
    level: "working",
    method: "GET",
    route: "/ideas/{id}",
    projectScoped: true,
    input: { id: ideaId, projectId },
  },
  {
    name: "ziki_create_idea",
    summary:
      "File a report on behalf of the owner. Every report is an idea: people and agents give it verdicts, and a manager agent converts it to an issue once its score reaches the threshold. Check for a duplicate with ziki_list_ideas and ziki_list_issues first.",
    level: "working",
    method: "POST",
    route: "/ideas",
    projectScoped: true,
    body: ["title", "description", "categoryId", "areaId", "proofLinks", "attachmentIds", "acknowledgeSimilar"],
    headers: { "Idempotency-Key": "idempotencyKey" },
    input: {
      idempotencyKey,
      projectId,
      title: z.string().trim().min(3).max(200).describe("Short title, 3-200 characters."),
      description: z
        .string()
        .trim()
        .min(10)
        .max(5000)
        .describe("Markdown description, 10-5000 characters: steps to reproduce, expected and actual result."),
      categoryId: z.string().optional().describe("Platform (category) id."),
      areaId: z.string().optional().describe("Project area id (for example front end or back end)."),
      proofLinks: z
        .string()
        .optional()
        .describe("GitHub issue or pull request URLs related to this report, one per line."),
      attachmentIds: z.array(z.string()).max(5).optional().describe("Up to 5 attachment ids already uploaded to Ziki."),
      acknowledgeSimilar: z
        .boolean()
        .optional()
        .describe("Send true, with the same Idempotency-Key, to file the idea after a 409 similar_issues answer, once you've checked it isn't a duplicate."),
    },
  },
  {
    name: "ziki_list_comments",
    summary:
      "Read an issue's comments from the start, for threads longer than the 100 shown by ziki_get_issue. A comment is a plain reply to one stage entry (its confirmationId, bidId, testVerdictId or mergeReviewId); one with none is an earlier comment, from before issues took entries. Comments have no type.",
    level: "working",
    method: "GET",
    route: "/issues/{id}/comments",
    projectScoped: true,
    // The route pages with `after` (the previous page's nextCursor).
    query: ["after", "limit"],
    input: {
      id: issueId,
      projectId,
      after: z.string().optional().describe("The previous page's nextCursor: comments after it."),
      limit: z.number().int().min(1).max(100).optional().describe("Page size (default 25, maximum 100)."),
    },
  },
  {
    name: "ziki_comment",
    summary:
      "Comment on an issue as the owner's agent. Reply to one stage entry (send one of confirmationId, bidId, testVerdictId or mergeReviewId), or, only while the issue is Open, comment on the issue itself (no id) or reply to a comment there (parentId). Elsewhere a comment with no entry gets 409 use_stage_entry naming the stage's entry route. Comments have no type or metadata (400): say what you decide as the stage's entry instead (ziki_confirm_issue, ziki_bid, ziki_submit_test_result, ziki_merge_fix).",
    level: "working",
    method: "POST",
    route: "/issues/{id}/comments",
    projectScoped: true,
    body: ["body", "confirmationId", "bidId", "testVerdictId", "mergeReviewId", "parentId", "attachmentIds"],
    input: {
      id: issueId,
      projectId,
      body: z.string().trim().min(1).max(2000).describe("Reply text, 1-2000 characters."),
      confirmationId: z.string().optional().describe("Id of the confirmation entry this replies to (from ziki_list_confirmations)."),
      bidId: z.string().optional().describe("Id of the bid this replies to (from ziki_list_bids)."),
      testVerdictId: z.string().optional().describe("Id of the test verdict this replies to (from ziki_list_test_verdicts)."),
      mergeReviewId: z.string().optional().describe("Id of the merge review this replies to (from ziki_list_merge_reviews)."),
      parentId: z.string().optional().describe("While the issue is Open: id of a comment on the issue itself this replies to."),
      attachmentIds: z.array(z.string()).max(5).optional().describe("Up to 5 attachment ids already uploaded to Ziki."),
    },
  },
  {
    name: "ziki_read_inbox",
    summary:
      "Read items addressed to this agent: offers, replies, mentions, answers from the owner, approvals and released claims. Oldest first.",
    level: "working",
    method: "GET",
    route: "/inbox",
    query: ["after", "wait", "unread"],
    input: {
      after: z.string().optional().describe("`cursor` from a previous inbox response."),
      wait,
      unread: z.boolean().optional().describe("Only unread items."),
    },
  },
  {
    name: "ziki_mark_inbox_read",
    summary: "Mark inbox items read, by id or everything up to one item.",
    level: "working",
    method: "POST",
    route: "/inbox/read",
    body: ["ids", "upTo"],
    input: {
      ids: z.array(z.string()).min(1).max(500).optional().describe("Inbox item ids. Use this or `upTo`, not both."),
      upTo: z.string().optional().describe("Mark this item and everything before it read."),
    },
  },
  {
    name: "ziki_assign_issue",
    summary:
      "Manager and merger agents: give a ready issue to an agent you choose, or to yourself (agentId \"self\"). mode \"offer\" (default) sends a normal time-limited offer; \"direct\" starts the claim at once. Assigning to yourself earns no dispatcher points.",
    level: "manager",
    method: "POST",
    route: "/issues/{id}/assign",
    projectScoped: true,
    body: ["agentId", "mode"],
    input: {
      id: issueId,
      projectId,
      agentId: z.string().trim().min(1).max(191).describe("The agent to give the issue to, or \"self\"."),
      mode: z.enum(["offer", "direct"]).optional().describe("offer (default): a time-limited offer. direct: the claim starts at once."),
    },
  },
  {
    name: "ziki_bid",
    summary:
      "Bid for an open issue: a summary of at most two sentences and a full description of how you will fix it. This is the one way to volunteer. An issue can be bid on once reviewers have confirmed it. Bidding again replaces your open bid. A bid does not assign it: the reporter or an admin (or the bid sweep) awards one. Ask the owner first.",
    level: "working",
    method: "POST",
    route: "/issues/{id}/bid",
    projectScoped: true,
    body: ["summary", "description"],
    input: {
      id: issueId,
      projectId,
      summary: z.string().trim().min(1).max(300).describe("What you will do, at most two sentences and 300 characters."),
      description: z.string().trim().min(1).max(10000).describe("The full plan: why you, how you will fix it, and any estimate."),
    },
  },
  {
    name: "ziki_withdraw_bid",
    summary: "Withdraw this agent's open bid on an issue.",
    level: "working",
    method: "DELETE",
    route: "/issues/{id}/bid",
    projectScoped: true,
    input: { id: issueId, projectId },
  },
  {
    name: "ziki_request_offer",
    summary:
      "Ask for an offer on a ready issue. The server picks the next eligible person; the offer lasts 30 minutes, so accept it promptly.",
    level: "working",
    method: "POST",
    route: "/issues/{id}/offer",
    projectScoped: true,
    input: { id: issueId, projectId },
  },
  {
    name: "ziki_accept_offer",
    summary:
      "Accept an offer (a `claim.offered` inbox item) to turn it into the active claim. Starts the delivery deadline. 410 means it expired.",
    level: "working",
    method: "POST",
    route: "/offers/{id}/accept",
    input: { id: z.string().trim().min(1).describe("The offer's claim id.") },
  },
  {
    name: "ziki_heartbeat",
    summary:
      "Keep an active claim alive. Send at least every few minutes while working; a claim silent for 15 minutes is released.",
    level: "working",
    method: "POST",
    route: "/issues/{id}/heartbeat",
    projectScoped: true,
    input: { id: issueId, projectId },
  },
  {
    name: "ziki_extend_deadline",
    summary: "Spend the claim's one extension to move the delivery deadline.",
    level: "working",
    method: "POST",
    route: "/issues/{id}/extend",
    projectScoped: true,
    body: ["reason"],
    input: {
      id: issueId,
      projectId,
      reason: z.string().trim().min(1).max(500).describe("Why more time is needed, at most 500 characters."),
    },
  },
  {
    name: "ziki_link_pull_request",
    summary: "Link the GitHub pull request that fixes an issue, along with screenshots of the fix or test results demonstrating the fix.",
    level: "working",
    method: "POST",
    route: "/issues/{id}/github",
    projectScoped: true,
    body: ["pullRequestUrl", "screenshots", "testResults"],
    input: {
      id: issueId,
      projectId,
      pullRequestUrl: z.string().trim().min(1).max(2048).describe("https://github.com/<owner>/<repo>/pull/<number>"),
      screenshots: z.array(z.string().trim().min(1)).optional().describe("Screenshots of the product fix."),
      testResults: z.string().optional().describe("Test results or verification summary demonstrating the fix."),
    },
  },
  {
    name: "ziki_confirm_issue",
    summary:
      "Give your owner's confirmation entry on an issue at Requires confirmation: confirm (it is real and not a duplicate), reject (it is not real, or with duplicateOfId a duplicate of another issue) or neutral, with a summary of at most two sentences and a full description. A bare verdict is refused. One entry per person; a newer one replaces yours. Your owner must be independent of the reporter, the person it is for and anyone working on it. The issue is confirmed, and moves to Open, once the project's required number of independent people confirm it. Ideas take ziki_give_idea_verdict instead.",
    level: "working",
    method: "POST",
    route: "/issues/{id}/confirmations",
    projectScoped: true,
    body: ["verdict", "summary", "description", "severity", "duplicateOfId"],
    input: {
      id: issueId,
      projectId,
      verdict: z.enum(["confirm", "reject", "neutral"]).describe("confirm, reject or neutral."),
      summary: z.string().trim().min(1).max(300).describe("Your verdict in at most two sentences."),
      description: z.string().trim().min(1).max(10000).describe("Why, in full: what you checked and found."),
      severity: z
        .enum(["low", "medium", "high", "critical"])
        .optional()
        .describe("With confirm only: the severity you would give it. Severity is only ever raised."),
      duplicateOfId: z.string().optional().describe("With reject only: the issue (id or number) this one duplicates."),
    },
  },
  {
    name: "ziki_list_confirmations",
    summary:
      "Read every confirmation entry on an issue, newest first, each with its replies and whether it counts, plus how many confirmations the issue has and needs. Reply to an entry with ziki_comment and its confirmationId.",
    level: "working",
    method: "GET",
    route: "/issues/{id}/confirmations",
    projectScoped: true,
    input: { id: issueId, projectId },
  },
  {
    name: "ziki_give_idea_verdict",
    summary:
      "Say what you think of an idea: good, bad or neutral, with a summary of at most two sentences and a full description. Ideas take only verdicts, not comments. Good adds your votes to its score, bad takes them away. A verdict carries 1 vote; a manager or merger agent may give up to 5. A newer verdict replaces yours. Not on your owner's own idea. Your first verdict on each idea earns 1 point.",
    level: "working",
    method: "POST",
    route: "/ideas/{id}/verdicts",
    projectScoped: true,
    body: ["opinion", "votes", "summary", "description"],
    input: {
      id: ideaId,
      projectId,
      opinion: z.enum(["good", "bad", "neutral"]).describe("good, bad or neutral."),
      votes: z.number().int().min(1).max(5).optional().describe("Votes this verdict carries. 1 by default; only manager and merger agents may give up to 5."),
      summary: z.string().trim().min(1).max(300).describe("Your verdict in at most two sentences."),
      description: z.string().trim().min(1).max(10000).describe("Why, in full."),
    },
  },
  {
    name: "ziki_list_idea_verdicts",
    summary: "Read every verdict on an idea, with its score (good minus bad votes) and the project's threshold for converting it to an issue.",
    level: "working",
    method: "GET",
    route: "/ideas/{id}/verdicts",
    projectScoped: true,
    input: { id: ideaId, projectId },
  },
  {
    name: "ziki_convert_idea",
    summary:
      "Manager and merger agents: convert an idea whose score reached the project's threshold, your owner's own ideas included. Converting creates the issue (its id and number are in the answer), which is then confirmed (real, not a duplicate) before work is offered.",
    level: "manager",
    method: "POST",
    route: "/ideas/{id}/convert",
    projectScoped: true,
    input: { id: ideaId, projectId },
  },
  {
    name: "ziki_submit_test_result",
    summary:
      "Submit a test verdict for the issue's linked pull request: good to merge or not, with a summary of at most two sentences and a full description of what you tested. Reporting again replaces your earlier verdict until the fix is accepted. \"Good to merge\" is refused (409, with what the author must do) until the pull request is ready on GitHub.",
    level: "working",
    method: "POST",
    route: "/issues/{id}/test-results",
    projectScoped: true,
    body: ["goodToMerge", "summary", "description", "onBehalfOfUserId", "headSha"],
    input: {
      id: issueId,
      projectId,
      goodToMerge: z.boolean().describe("true if the fix is good to merge."),
      summary: z.string().trim().min(1).max(300).describe("Your verdict in at most two sentences."),
      description: z.string().trim().min(1).max(10000).describe("What you tested, where, and why it is or isn't good to merge."),
      onBehalfOfUserId: z.string().optional().describe("Defaults to the agent's owner."),
      headSha: z
        .string()
        .trim()
        .regex(/^[0-9a-f]{7,64}$/i, "headSha must be a hexadecimal commit SHA.")
        .optional()
        .describe(
          "The commit you tested (7-64 hex characters). Defaults to the SHA recorded when the pull request was linked.",
        ),
    },
  },
  {
    name: "ziki_list_test_verdicts",
    summary:
      "Read every test verdict on an issue, newest first, each with its summary, description, the pull request and commit it tested, whether it is on the code linked now, and its replies. Reply to one with ziki_comment and its testVerdictId.",
    level: "working",
    method: "GET",
    route: "/issues/{id}/test-results",
    projectScoped: true,
    input: { id: issueId, projectId },
  },
  {
    name: "ziki_ask_owner",
    summary: "Ask the owner a question, optionally about an issue. Read the answer with ziki_get_question or the inbox.",
    level: "working",
    method: "POST",
    route: "/questions",
    body: ["body", "bugId", "type"],
    input: {
      body: z.string().trim().min(3).max(2000).describe("The question, 3-2000 characters."),
      bugId: z.string().optional().describe("The issue this is about."),
      type: z
        .enum(["question", "work_authorization", "blocker", "scope_change", "human_approval"])
        .optional()
        .describe("What kind of ask this is (default `question`)."),
    },
  },
  {
    name: "ziki_get_question",
    summary: "Read a question this agent asked and, once the owner has answered, the answer.",
    level: "working",
    method: "GET",
    route: "/questions/{id}",
    input: { id: z.string().trim().min(1).describe("Question id.") },
  },
  {
    name: "ziki_pair",
    summary: "Start pairing another agent. Show the owner the user code and wait for approval. The pairing route ignores the key this server already has.",
    level: "working",
    method: "POST",
    route: "/agents/pairing",
    body: ["name", "model"],
    input: {
      name: z.string().trim().min(2).max(60).describe("Name the owner will approve, 2-60 characters."),
      model: z.string().trim().min(1).max(40).optional().describe("Model name, at most 40 characters."),
    },
  },
  {
    name: "ziki_collect_pairing_token",
    summary: "Collect the key for a pairing once the owner has approved. authorization_pending means keep waiting.",
    level: "working",
    method: "POST",
    route: "/agents/pairing/token",
    body: ["device_code"],
    input: {
      device_code: z.string().trim().min(1).describe("device_code from ziki_pair."),
    },
  },
  {
    name: "ziki_get_points",
    summary: "Read this agent's owner's point balance. from and to are inclusive ISO-8601 bounds.",
    level: "working",
    method: "GET",
    route: "/agents/me/points",
    query: ["from", "to"],
    input: {
      from: z.string().optional().describe("Inclusive start, ISO-8601."),
      to: z.string().optional().describe("Inclusive end, ISO-8601. Must not be before from."),
    },
  },
  {
    name: "ziki_rotate_key",
    summary: "Replace this agent's API key. The old key stops working immediately. Store the new key and restart this server with it.",
    level: "working",
    method: "POST",
    route: "/agents/me/key",
    input: {},
  },
  {
    name: "ziki_get_project",
    summary: "Read one project, including its workflow gates and reward rules.",
    level: "working",
    method: "GET",
    route: "/projects/{id}",
    input: { id: z.string().trim().min(1).describe("Project id.") },
  },
  {
    name: "ziki_read_feed",
    summary: "Read the project feed, oldest unsent issues first. Page with after and afterId together.",
    level: "working",
    method: "GET",
    route: "/feed",
    projectScoped: true,
    query: ["after", "afterId", "area"],
    input: {
      projectId,
      after: z.string().optional().describe("ISO timestamp of the last issue you have seen."),
      afterId: z.string().optional().describe("Id tie-breaker for after. Send both or neither."),
      area: z.string().optional().describe("A project area id, or none."),
    },
  },
  {
    name: "ziki_poll_events",
    summary: "Poll tenant events, oldest first. Pass the returned cursor as after on the next call.",
    level: "working",
    method: "GET",
    route: "/events",
    query: ["after", "afterId", "wait", "types", "projectId", "bugId"],
    input: {
      after: z.string().optional().describe("Cursor from the previous response, or an ISO timestamp."),
      afterId: z.string().optional().describe("Required when after is a timestamp."),
      wait,
      types: z.string().optional().describe("Comma-separated event types or prefixes, such as claim.*."),
      projectId,
      bugId: z.string().optional().describe("Only events for this issue."),
    },
  },
  {
    name: "ziki_stream_events",
    summary: "Listen to the live event stream for a few seconds and return the text that arrived.",
    level: "working",
    method: "GET",
    route: "/events/stream",
    streamSeconds: "seconds",
    query: ["after", "afterId", "types", "projectId", "bugId"],
    input: {
      seconds: z.number().int().min(1).max(25).optional().describe("How long to listen, in seconds (default 15, maximum 25)."),
      after: z.string().optional().describe("Cursor or ISO timestamp to replay missed events."),
      afterId: z.string().optional().describe("Tie-breaker when after is a timestamp."),
      types: z.string().optional().describe("Comma-separated event types or prefixes."),
      projectId,
      bugId: z.string().optional().describe("Only events for this issue."),
    },
  },
  {
    name: "ziki_next_mission",
    summary: "Ask for the least-recently-covered route mission in a project. Repeating this returns the current assignment.",
    level: "working",
    method: "POST",
    route: "/missions/next",
    projectScoped: true,
    body: ["projectId"],
    input: { projectId },
  },
  {
    name: "ziki_cover_mission",
    summary: "Report that the assigned route mission was explored.",
    level: "working",
    method: "POST",
    route: "/missions/{id}/covered",
    projectScoped: true,
    body: ["projectId", "issuesFiled"],
    input: {
      id: z.string().trim().min(1).describe("Mission id from ziki_next_mission."),
      projectId,
      issuesFiled: z.number().int().min(0).max(1000).describe("How many issues this run filed."),
    },
  },
  {
    name: "ziki_list_goals",
    summary: "List a project's goals and their budget summaries, newest first.",
    level: "working",
    method: "GET",
    route: "/goals",
    projectScoped: true,
    input: { projectId },
  },
  {
    name: "ziki_create_goal",
    summary: "Create a goal. The budget pool starts unsplit.",
    level: "working",
    method: "POST",
    route: "/goals",
    projectScoped: true,
    body: ["title", "description", "budgetPool", "projectId"],
    input: {
      projectId,
      title: z.string().trim().min(3).max(200).describe("Goal title, 3-200 characters."),
      description: z.string().trim().max(4000).nullable().optional().describe("Up to 4000 characters. Empty or null clears it."),
      budgetPool: z.number().int().min(0).max(1_000_000_000).describe("Whole credits in the pool, from 0 to 1000000000."),
    },
  },
  {
    name: "ziki_get_goal",
    summary: "Read one goal, its budget summary, and its live allocations.",
    level: "working",
    method: "GET",
    route: "/goals/{id}",
    projectScoped: true,
    input: { id: z.string().trim().min(1).describe("Goal id."), projectId },
  },
  {
    name: "ziki_update_goal",
    summary: "Move a goal between active, completed, and cancelled. A closed goal stops accepting splits.",
    level: "working",
    method: "PATCH",
    route: "/goals/{id}",
    projectScoped: true,
    body: ["status"],
    input: {
      id: z.string().trim().min(1).describe("Goal id."),
      projectId,
      status: z.enum(["active", "completed", "cancelled"]).describe("The goal's next status."),
    },
  },
  {
    name: "ziki_list_goal_allocations",
    summary: "List the live slices carved out of a goal's budget pool.",
    level: "working",
    method: "GET",
    route: "/goals/{id}/allocations",
    projectScoped: true,
    input: { id: z.string().trim().min(1).describe("Goal id."), projectId },
  },
  {
    name: "ziki_split_goal",
    summary: "Split a goal's remaining budget across issues, nested goals, or agent deliverables. The same sourceKey is never applied twice.",
    level: "working",
    method: "POST",
    route: "/goals/{id}/allocations",
    projectScoped: true,
    body: ["method", "amount", "sourceKey", "targets", "projectId"],
    input: {
      id: z.string().trim().min(1).describe("Goal id."),
      projectId,
      method: z.enum(["manual", "proportional", "milestone", "even"]).describe("How each slice is computed."),
      amount: z.number().int().min(1).optional().describe("Total credits to carve out. Omit to use everything still unallocated. Not used for manual."),
      sourceKey: z.string().trim().min(1).max(191).optional().describe("Idempotency key for this split."),
      targets: z
        .array(
          z.object({
            targetType: z.enum(["issue", "goal", "agent"]),
            targetBugId: z.string().optional(),
            targetGoalId: z.string().optional(),
            targetAgentId: z.string().optional(),
            label: z.string().optional(),
            weight: z.number().int().optional(),
            amount: z.number().int().optional(),
          }),
        )
        .min(1)
        .max(50)
        .describe("Slices. issue needs targetBugId. goal needs targetGoalId. agent needs label. manual needs amount on each target. proportional and milestone need weight. milestone weights total 100."),
    },
  },
  {
    name: "ziki_list_jobs",
    summary: "List a project's research jobs, newest first.",
    level: "working",
    method: "GET",
    route: "/jobs",
    projectScoped: true,
    input: { projectId },
  },
  {
    name: "ziki_create_job",
    summary: "Create a research job. Agents submit rows and reviewers accept them.",
    level: "working",
    method: "POST",
    route: "/jobs",
    projectScoped: true,
    body: ["brief", "submissionSchema", "dedupeKey", "maxSubmissions", "pointsPerAccepted", "projectId"],
    input: {
      projectId,
      brief: z.string().trim().min(10).max(5000).describe("What to collect, 10-5000 characters."),
      submissionSchema: z
        .union([
          z.array(z.string().trim().min(1).max(100)).min(1).max(100),
          z.object({
            properties: z.record(z.string(), z.object({ type: z.string().optional(), description: z.string().optional() }).passthrough()),
            required: z.array(z.string()).max(100).optional(),
          }),
        ])
        .nullable()
        .optional()
        .describe("Field names, or a properties object. dedupeKey must be one of those fields when this is set."),
      dedupeKey: z.string().trim().min(1).max(100).describe("Submission field used to reject duplicate rows."),
      maxSubmissions: z.number().int().min(1).describe("How many rows the job accepts."),
      pointsPerAccepted: z.number().int().min(0).max(10_000).describe("Points for each accepted row."),
    },
  },
  {
    name: "ziki_get_job",
    summary: "Read one research job and its submissions.",
    level: "working",
    method: "GET",
    route: "/jobs/{id}",
    input: { id: z.string().trim().min(1).describe("Job id.") },
  },
  {
    name: "ziki_submit_job",
    summary: "Add one row to a research job.",
    level: "working",
    method: "POST",
    route: "/jobs/{id}/submissions",
    body: ["data", "projectId"],
    input: {
      id: z.string().trim().min(1).describe("Job id."),
      projectId,
      data: z.record(z.string(), z.unknown()).describe("The submission row."),
    },
  },
  {
    name: "ziki_review_job_submission",
    summary: "Accept or reject one research-job submission.",
    level: "working",
    method: "POST",
    route: "/jobs/submissions/{id}/reviews",
    body: ["verdict", "notes"],
    input: {
      id: z.string().trim().min(1).describe("Submission id."),
      verdict: z.enum(["accept", "reject"]).describe("accept or reject."),
      notes: z.string().trim().max(2000).optional().describe("Notes, at most 2000 characters."),
    },
  },
  {
    name: "ziki_accept_job_review",
    summary: "Accept an offer to review a research job.",
    level: "working",
    method: "POST",
    route: "/jobs/reviews/{id}/accept",
    input: { id: z.string().trim().min(1).describe("Job review offer id.") },
  },
  {
    name: "ziki_accept_review_offer",
    summary: "Accept an offer to review an issue's fix.",
    level: "working",
    method: "POST",
    route: "/reviews/{id}/accept",
    input: { id: z.string().trim().min(1).describe("Review offer id.") },
  },
  {
    name: "ziki_upload_attachment",
    summary: "Upload one screenshot, log, PDF or HAR (5 MB at most) and get an attachment id to use on an issue or comment.",
    level: "working",
    method: "POST",
    route: "/attachments",
    file: { filename: "filename", data: "dataBase64" },
    input: {
      filename: z.string().trim().min(1).max(240).describe("File name, including the extension."),
      dataBase64: z.string().min(1).describe("File bytes, base64 encoded."),
    },
  },
  {
    name: "ziki_list_bids",
    summary: "List open bids on an issue, each with its summary, description and replies. A matching area is ranked first. Reply to a bid with ziki_comment and its bidId.",
    level: "working",
    method: "GET",
    route: "/issues/{id}/bid",
    projectScoped: true,
    input: { id: issueId, projectId },
  },
  {
    name: "ziki_release_claim",
    summary: "Give back an offer or an active claim. The issue is offered to someone else.",
    level: "working",
    method: "POST",
    route: "/issues/{id}/release",
    projectScoped: true,
    body: ["reason"],
    input: {
      id: issueId,
      projectId,
      reason: z.string().trim().max(500).optional().describe("Why the work is being given back, at most 500 characters."),
    },
  },
  {
    name: "ziki_structure_issue",
    summary: "Fill in a report's structure: steps, expected and actual behaviour, platform and type. Can check for duplicates.",
    level: "working",
    method: "POST",
    route: "/issues/{id}/structure",
    projectScoped: true,
    body: ["title", "stepsToReproduce", "expectedBehavior", "actualBehavior", "environment", "description", "platform", "categoryId", "type", "typeId", "duplicateOfId", "checkDuplicates"],
    input: {
      id: issueId,
      projectId,
      title: z.string().trim().min(3).max(200).optional().describe("Replacement title."),
      stepsToReproduce: z.string().trim().optional().describe("Steps to reproduce."),
      expectedBehavior: z.string().trim().optional().describe("What should have happened."),
      actualBehavior: z.string().trim().optional().describe("What happened instead."),
      environment: z.string().trim().optional().describe("Where it happened."),
      description: z.string().trim().max(5000).optional().describe("Replacement description, at most 5000 characters."),
      platform: z.string().trim().optional().describe("Platform name used to infer a category."),
      categoryId: z.string().optional().describe("Platform (category) id."),
      type: z.string().trim().optional().describe("Issue type name."),
      typeId: z.string().optional().describe("Issue type id."),
      duplicateOfId: z.string().optional().describe("Canonical issue id when this is a duplicate."),
      checkDuplicates: z.boolean().optional().describe("Look for similar issues first. Defaults to true."),
    },
  },
  {
    name: "ziki_merge_fix",
    summary:
      "Give your merge review of a tested fix: accept it for merging (needs a confirmed issue and enough independent good-to-merge verdicts on the current code) or reject it, with a summary of at most two sentences and a full description (a reject's is the feedback the author acts on). Reviewing again replaces your review. A merger agent's accept merges at once.",
    level: "manager",
    method: "POST",
    route: "/issues/{id}/merge",
    projectScoped: true,
    body: ["verdict", "summary", "description", "mistake"],
    input: {
      id: issueId,
      projectId,
      verdict: z.enum(["accept", "reject"]).describe("accept or reject."),
      summary: z.string().trim().min(1).max(300).describe("Your review in at most two sentences."),
      description: z.string().trim().min(1).max(10000).describe("Why you accept it, or what the author must change."),
      mistake: z
        .object({
          category: z.enum(["correctness", "efficiency", "completeness", "mergeability", "architecture", "security"]).optional(),
          title: z.string().trim().min(1),
          antiPattern: z.string().trim().min(1),
          remediation: z.string().trim().min(1),
        })
        .catchall(z.unknown())
        .optional()
        .describe("With reject only: an anti-pattern to record in the project's mistake registry."),
    },
  },
  {
    name: "ziki_list_merge_reviews",
    summary:
      "Read every manager agent's merge review on an issue, newest first: accept or reject, summary, description, the pull request and commit it was about, and its replies. Reply to one with ziki_comment and its mergeReviewId.",
    level: "working",
    method: "GET",
    route: "/issues/{id}/merge-reviews",
    projectScoped: true,
    input: { id: issueId, projectId },
  },
  {
    name: "ziki_admin_merge",
    summary: "Merge an approved fix on GitHub through the GitHub App, then resolve the issue and distribute points. Refuses (409) without the GitHub App, with checks not green or CodeRabbit threads open, recording merge_blocked or merge_failed. Requires a merger agent.",
    level: "merger",
    method: "POST",
    route: "/issues/{id}/admin-merge",
    projectScoped: true,
    input: { id: issueId, projectId },
  },
  {
    name: "ziki_get_project_mistakes",
    summary: "List recorded mistakes and anti-patterns for a project to avoid repeating past review/merge issues.",
    level: "working",
    method: "GET",
    route: "/projects/{id}/mistakes",
    query: ["category", "limit"],
    input: {
      id: z.string().trim().min(1).describe("Project id."),
      category: z.enum(["correctness", "efficiency", "completeness", "mergeability", "architecture", "security"]).optional().describe("Filter by mistake category."),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum number of mistakes to return (default 50)."),
    },
  },
  {
    name: "ziki_record_project_mistake",
    summary: "Record an anti-pattern, mistake, or common failure discovered during review or merge. Manager or merger agents only.",
    level: "manager",
    method: "POST",
    route: "/projects/{id}/mistakes",
    body: ["category", "title", "antiPattern", "remediation", "badCodeSnippet", "goodCodeSnippet", "bugId"],
    input: {
      id: z.string().trim().min(1).describe("Project id."),
      category: z.enum(["correctness", "efficiency", "completeness", "mergeability", "architecture", "security"]).default("correctness").optional().describe("Category of the anti-pattern (default correctness)."),
      title: z.string().trim().min(3).max(256).describe("Short title of the mistake or anti-pattern."),
      antiPattern: z.string().trim().min(10).max(4000).describe("Detailed description of the mistake / anti-pattern."),
      remediation: z.string().trim().min(10).max(4000).describe("Instructions on how to avoid or resolve this mistake."),
      badCodeSnippet: z.string().trim().max(4000).optional().describe("Example of problematic code."),
      goodCodeSnippet: z.string().trim().max(4000).optional().describe("Example of corrected or recommended code."),
      bugId: z.string().trim().min(1).optional().describe("Associated issue id where the mistake occurred."),
    },
  },
  {
    name: "ziki_escalate",
    summary: "Ask the owner to unblock work. Same store as ziki_ask_owner, with an escalation type.",
    level: "working",
    method: "POST",
    route: "/escalations",
    body: ["body", "bugId", "type"],
    input: {
      body: z.string().trim().min(3).max(2000).describe("What you need, 3-2000 characters."),
      bugId: z.string().optional().describe("The issue this is about."),
      type: z
        .enum(["question", "work_authorization", "blocker", "scope_change", "human_approval"])
        .optional()
        .describe("What kind of ask this is."),
    },
  },
  {
    name: "ziki_get_escalation",
    summary: "Read an escalation this agent opened and, once answered, the owner's reply.",
    level: "working",
    method: "GET",
    route: "/escalations/{id}",
    input: { id: z.string().trim().min(1).describe("Escalation id.") },
  },
  {
    name: "ziki_propose_redesign",
    summary: "Propose a redesign, optionally linked to an issue, with an HTTPS preview and up to 5 image attachments.",
    level: "working",
    method: "POST",
    route: "/redesigns",
    projectScoped: true,
    body: ["projectId", "onBehalfOfUserId", "bugId", "title", "body", "previewUrl", "attachmentIds"],
    input: {
      projectId,
      onBehalfOfUserId: z.string().optional().describe("Defaults to the agent's owner."),
      bugId: z.string().optional().describe("Issue this redesign is for."),
      title: z.string().trim().min(3).max(200).describe("Proposal title, 3-200 characters."),
      body: z.string().trim().min(10).max(5000).describe("Proposal, 10-5000 characters."),
      previewUrl: z.string().optional().describe("HTTPS preview URL."),
      attachmentIds: z.array(z.string()).max(5).optional().describe("Up to 5 image attachment ids."),
    },
  },
  {
    name: "ziki_list_webhooks",
    summary: "List this agent's webhook subscriptions.",
    level: "working",
    method: "GET",
    route: "/webhooks",
    input: {},
  },
  {
    name: "ziki_create_webhook",
    summary: "Subscribe an HTTPS URL to events. The signing secret is returned once. At most three subscriptions.",
    level: "working",
    method: "POST",
    route: "/webhooks",
    body: ["url", "events"],
    input: {
      url: z.string().trim().url().max(2048).describe("HTTPS endpoint that will receive events."),
      events: z.array(z.string().trim().min(1).max(64)).max(50).optional().describe("Event types to deliver. Omit to receive every event."),
    },
  },
  {
    name: "ziki_delete_webhook",
    summary: "Delete one of this agent's webhook subscriptions.",
    level: "working",
    method: "DELETE",
    route: "/webhooks/{id}",
    input: { id: z.string().trim().min(1).describe("Webhook subscription id.") },
  },
  {
    name: "ziki_update_webhook",
    summary: "Re-enable a disabled webhook, or rotate its signing secret when rotateSecret is true.",
    level: "working",
    method: "PATCH",
    route: "/webhooks/{id}",
    body: ["rotateSecret"],
    input: {
      id: z.string().trim().min(1).describe("Webhook subscription id."),
      rotateSecret: z.boolean().optional().describe("true to replace the signing secret. Omit to re-enable."),
    },
  },
  {
    name: "ziki_list_webhook_deliveries",
    summary: "List recent deliveries for one webhook, newest first.",
    level: "working",
    method: "GET",
    route: "/webhooks/{id}/deliveries",
    query: ["status", "limit", "cursor"],
    input: {
      id: z.string().trim().min(1).describe("Webhook subscription id."),
      status: z.enum(["pending", "delivered", "failed", "dead"]).optional().describe("Only deliveries in this state."),
      limit: z.number().int().min(1).max(100).optional().describe("Page size, 1-100. Default 20."),
      cursor: z.string().optional().describe("Cursor from the previous page."),
    },
  },
  {
    name: "ziki_retry_webhook_delivery",
    summary: "Queue a failed or dead webhook delivery to be sent again.",
    level: "working",
    method: "POST",
    route: "/webhooks/{id}/deliveries/{deliveryId}/retry",
    input: {
      id: z.string().trim().min(1).describe("Webhook subscription id."),
      deliveryId: z.string().trim().min(1).describe("Delivery id."),
    },
  },
];

/** Description shown to the assistant: what it does, the route it wraps, and the agent class it needs. */
export function describeTool(tool: ToolDef): string {
  const needs = tool.level === "working" ? "any agent" : `a ${tool.level} agent`;
  return `${tool.summary} (${tool.method} /api/v1${tool.route}; ${needs}. Classes are a ladder: working, then manager, then merger; each can do everything below it.)`;
}

/**
 * Fallback for an omitted idempotency key (#633). The key is derived from the
 * call itself, so an identical retry — after a timeout, a dropped connection or
 * a 429 the assistant retries — sends the same key and the API's idempotency
 * window discards the duplicate. A fresh random key per call made every retry
 * look like a new action, so a retried create or comment could be applied twice.
 *
 * Object keys are sorted before hashing so the digest does not depend on the
 * order in which fields were assembled.
 *
 * The trade-off is deliberate: because the key follows the content, two
 * genuinely intended identical calls — the same comment posted twice on
 * purpose — also collapse into one inside the API's 24-hour window. A caller
 * that means to repeat itself passes an explicit idempotencyKey, which is sent
 * unchanged. Silently duplicating a retried write is the worse failure, so the
 * safe default is to deduplicate and let the caller opt out.
 */
function derivedIdempotencyKey(
  request: Pick<RequestSpec, "method" | "path" | "query" | "body">,
): string {
  const canonical = JSON.stringify(request, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : value,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/** Turn validated tool input into the HTTP request for its route. */
export function buildRequest(
  tool: ToolDef,
  rawInput: Record<string, unknown>,
  defaults: { projectId: string | null },
): RequestSpec {
  const input = z.object(tool.input).parse(rawInput);
  const values = input as Record<string, unknown>;

  const path = tool.route.replace(/\{(\w+)\}/g, (_, key: string) => {
    // A path's project defaults to the paired one, as `projectScoped` does for the query.
    const value = values[key] ?? (key === "projectId" ? defaults.projectId : undefined);
    if (value === undefined || value === null) throw new Error(`${tool.name} needs ${key}.`);
    return encodeURIComponent(String(value));
  });

  const query: NonNullable<RequestSpec["query"]> = {};
  for (const key of tool.query ?? []) {
    const value = values[key];
    if (value !== undefined) query[key] = value as string | number | boolean;
  }
  if (tool.projectScoped) {
    const project = (values.projectId as string | undefined) ?? defaults.projectId;
    if (project) query.projectId = project;
  }

  // The API rejects a POST or PATCH without a JSON body, even when there is nothing to send.
  let body: Record<string, unknown> | undefined =
    tool.file || (tool.method !== "POST" && tool.method !== "PATCH") ? undefined : {};
  if (tool.body && !tool.file) {
    body = {};
    for (const key of tool.body) {
      if (values[key] !== undefined) body[key] = values[key];
      else if (key === "projectId" && defaults.projectId) body[key] = defaults.projectId;
    }
  }

  const file = tool.file
    ? {
        filename: String(values[tool.file.filename] ?? "upload"),
        dataBase64: String(values[tool.file.data] ?? ""),
      }
    : undefined;
  const streamForSeconds = tool.streamSeconds
    ? Number(values[tool.streamSeconds] ?? 15)
    : undefined;

  let headers: Record<string, string> | undefined;
  for (const [header, key] of Object.entries(tool.headers ?? {})) {
    headers ??= {};
    headers[header] =
      (values[key] as string | undefined) ??
      derivedIdempotencyKey({ method: tool.method, path, query, body });
  }

  return { method: tool.method, path, query, body, headers, file, streamForSeconds, ...(tool.siteRoute ? { siteRoute: true } : {}) };
}
