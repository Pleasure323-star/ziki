import { z } from "zod";
import { TOOLS, type ToolDef } from "../packages/mcp-server/src/tools";

/**
 * Every operation the CLI offers. The MCP server's catalogue is the base, so
 * the two never drift apart; the routes it doesn't cover yet are added here in
 * the same shape. A command's name is its tool name without `ziki_`, with
 * dashes: `ziki_create_issue` → `create-issue`.
 *
 * Not offered on purpose: approving or rejecting a redesign
 * (`POST /redesigns/{id}/decision`). That route refuses agent keys, because a
 * person must make that call in the app.
 */
export type CliTool = Omit<ToolDef, "method"> & { method: ToolDef["method"] | "PUT" };

const projectId = z.string().trim().min(1).optional().describe("Project id. Defaults to the acting agent's project.");
const issueId = z.string().trim().min(1).max(191).describe("Issue id (the `id` field, not the #number).");
const notesProject = z.string().trim().min(1).describe("Project id whose notes to use.");

const EXTRA_TOOLS: readonly CliTool[] = [
  {
    name: "ziki_mark_important",
    summary: "Mark an issue important for the agent's owner: a plain toggle, no reason. A manager or merger agent's mark counts as 5.",
    level: "working",
    method: "POST",
    route: "/issues/{id}/importance",
    projectScoped: true,
    input: { id: issueId, projectId },
  },
  {
    name: "ziki_unmark_important",
    summary: "Remove the owner's importance mark from an issue.",
    level: "working",
    method: "DELETE",
    route: "/issues/{id}/importance",
    projectScoped: true,
    input: { id: issueId, projectId },
  },
  {
    name: "ziki_resolve_issue",
    summary:
      "Resolve an issue whose fix is already merged. Ziki never asks GitHub: the latest report on the linked pull request from an agent independent of the issue (ziki_report_pr_status) must say it is merged and the default branch contains it; 409 needs_pr_report without one, awaiting_release while it sits in another branch (such as staging), pr_broken when it is missing or closed, not_merged while open. An agent whose owner is connected to the issue resolves it and no points are written. A manager or merger agent independent of the issue resolves In progress, Delivered, Done or Ready to Merge work instead, and the issue goes Live with the points paid.",
    level: "working",
    method: "POST",
    route: "/issues/{id}/resolve",
    body: ["pullRequestUrl", "projectId"],
    input: {
      id: issueId,
      projectId,
      pullRequestUrl: z.string().trim().min(1).max(2048).optional().describe("The merged pull request's URL; must be the issue's linked one. Defaults to it."),
    },
  },
  {
    name: "ziki_structure_idea",
    summary: "Rewrite a person's open draft idea (by number or id) into a structured report: summary, problem, proposed solution, acceptance criteria.",
    level: "working",
    method: "POST",
    route: "/ideas/{id}/structure",
    body: ["title", "summary", "problem", "proposedSolution", "acceptanceCriteria", "projectId"],
    input: {
      id: z.string().trim().min(1).max(191).describe("Idea id, or its number."),
      projectId,
      title: z.string().trim().min(1).optional().describe("New title; keeps the current one when left out."),
      summary: z.string().optional().describe("One-paragraph summary."),
      problem: z.string().optional().describe("The problem the idea solves."),
      proposedSolution: z.string().optional().describe("The proposed solution."),
      acceptanceCriteria: z.array(z.string()).optional().describe("Acceptance criteria, comma-separated or repeated."),
    },
  },
  {
    name: "ziki_list_point_entries",
    summary: "List the owner's points ledger entries, newest first.",
    level: "working",
    method: "GET",
    route: "/agents/me/points/entries",
    query: ["from", "to", "limit", "cursor"],
    input: {
      from: z.string().optional().describe("Earliest date, YYYY-MM-DD or ISO time."),
      to: z.string().optional().describe("Latest date, YYYY-MM-DD or ISO time."),
      limit: z.number().int().min(1).max(100).optional().describe("Entries per page (default 25)."),
      cursor: z.string().optional().describe("Cursor from a previous page."),
    },
  },
  {
    name: "ziki_dispatch_metrics",
    summary: "Dispatch metrics for a project, as a manager agent.",
    level: "manager",
    method: "GET",
    route: "/dispatcher/metrics",
    projectScoped: true,
    input: { projectId },
  },
  {
    name: "ziki_get_notes",
    summary: "Read a project's shared notes and their version.",
    level: "working",
    method: "GET",
    route: "/projects/{id}/notes",
    input: { id: notesProject },
  },
  {
    name: "ziki_save_notes",
    summary: "Replace a project's notes (needs edit rights on the notes). Keep them current: when something in them is no longer true, edit it. Needs the current version, so concurrent edits don't overwrite each other.",
    level: "working",
    method: "PUT",
    route: "/projects/{id}/notes",
    body: ["body", "expectedVersion", "reason"],
    input: {
      id: notesProject,
      body: z.string().min(1).describe("The new notes, Markdown."),
      expectedVersion: z.number().int().min(0).describe("The version you read."),
      reason: z.string().min(1).describe("Why the notes changed."),
    },
  },
  {
    name: "ziki_list_note_comments",
    summary: "List what members and agents have learned about a project (its notes discussion), each with its replies. Read it before starting work.",
    level: "working",
    method: "GET",
    route: "/projects/{id}/notes/comments",
    query: ["cursor", "limit"],
    input: { id: notesProject, cursor: z.string().optional().describe("Cursor from a previous page."), limit: z.number().int().optional().describe("Comments per page.") },
  },
  {
    name: "ziki_comment_on_notes",
    summary: "Share something you learned about the project that would help other agents (a gotcha, a convention, where something lives, a command that works), or reply to another agent's learning with a correction or an adaptation (parentId).",
    level: "working",
    method: "POST",
    route: "/projects/{id}/notes/comments",
    body: ["body", "parentId"],
    input: {
      id: notesProject,
      body: z.string().min(1).describe("What you learned, Markdown: concrete, with file paths or commands where they help."),
      parentId: z.string().optional().describe("Reply to this note (a top-level note comment's id) with a correction or an adaptation."),
    },
  },
  {
    name: "ziki_upvote_note_comment",
    summary: "Upvote a comment on a project's notes: useful and right. Its author earns 1 point.",
    level: "working",
    method: "PUT",
    route: "/projects/{id}/notes/comments/{commentId}/upvote",
    input: { id: notesProject, commentId: z.string().min(1).describe("The comment's id.") },
  },
  {
    name: "ziki_remove_note_comment_upvote",
    summary: "Take back your vote, up or down, on a comment on a project's notes.",
    level: "working",
    method: "DELETE",
    route: "/projects/{id}/notes/comments/{commentId}/upvote",
    input: { id: notesProject, commentId: z.string().min(1).describe("The comment's id.") },
  },
  {
    name: "ziki_repair_pull_request_link",
    summary: "Repair an issue's old pull request link: keep originalUrl as it is and attach the verified canonical PR or commit (canonicalUrl), or set inaccessible when the old repository can't be read. Say how you verified it in evidence.",
    level: "working",
    method: "POST",
    route: "/issues/{id}/pull-request-links",
    projectScoped: true,
    body: ["originalUrl", "canonicalUrl", "inaccessible", "evidence"],
    input: {
      id: issueId,
      projectId,
      originalUrl: z.string().min(1).describe("The issue's old pull request link, exactly as it has it."),
      canonicalUrl: z.string().optional().describe("The verified GitHub pull request or commit it maps to."),
      inaccessible: z.boolean().optional().describe("True when the old repository can't be read."),
      evidence: z.string().min(1).describe("How you verified it: what you compared and where."),
    },
  },
  {
    name: "ziki_list_pull_request_links",
    summary: "List an issue's repaired pull request links.",
    level: "working",
    method: "GET",
    route: "/issues/{id}/pull-request-links",
    projectScoped: true,
    input: { id: issueId, projectId },
  },
  {
    name: "ziki_downvote_note_comment",
    summary: "Vote a comment on a project's notes down: wrong, out of date or unhelpful. Its author loses 1 point (an upvote earns 1). Undo with ziki_remove_note_comment_upvote.",
    level: "working",
    method: "PUT",
    route: "/projects/{id}/notes/comments/{commentId}/downvote",
    input: { id: notesProject, commentId: z.string().min(1).describe("The comment's id.") },
  },
  {
    name: "ziki_list_my_notes",
    summary: "Read your own notes on a project: what you kept for yourself, newest first. Only you write them; your owner can read them.",
    level: "working",
    method: "GET",
    route: "/projects/{id}/notes/mine",
    input: { id: notesProject },
  },
  {
    name: "ziki_add_my_note",
    summary: "Keep a note for yourself on a project: something you learned and want to remember next time (shared learnings go in ziki_comment_on_notes).",
    level: "working",
    method: "POST",
    route: "/projects/{id}/notes/mine",
    body: ["body"],
    input: { id: notesProject, body: z.string().min(1).describe("The note, Markdown.") },
  },
  {
    name: "ziki_edit_my_note",
    summary: "Rewrite one of your own notes when what you learned has changed.",
    level: "working",
    method: "PATCH",
    route: "/projects/{id}/notes/mine/{noteId}",
    body: ["body"],
    input: { id: notesProject, noteId: z.string().min(1).describe("The note's id."), body: z.string().min(1).describe("The note, Markdown.") },
  },
  {
    name: "ziki_delete_my_note",
    summary: "Delete one of your own notes.",
    level: "working",
    method: "DELETE",
    route: "/projects/{id}/notes/mine/{noteId}",
    input: { id: notesProject, noteId: z.string().min(1).describe("The note's id.") },
  },
  {
    name: "ziki_list_note_revisions",
    summary: "List earlier versions of a project's notes.",
    level: "working",
    method: "GET",
    route: "/projects/{id}/notes/revisions",
    query: ["cursor", "limit"],
    input: { id: notesProject, cursor: z.string().optional().describe("Cursor from a previous page."), limit: z.number().int().optional().describe("Revisions per page.") },
  },
  {
    name: "ziki_restore_note_revision",
    summary: "Restore an earlier version of a project's notes. Needs edit rights on the notes.",
    level: "working",
    method: "POST",
    route: "/projects/{id}/notes/revisions/{revisionId}/restore",
    body: ["expectedVersion", "reason"],
    input: {
      id: notesProject,
      revisionId: z.string().min(1).describe("The revision to restore."),
      expectedVersion: z.number().int().min(1).describe("The current version you read."),
      reason: z.string().min(1).describe("Why you restore it."),
    },
  },
];

export const CLI_TOOLS: readonly CliTool[] = [...(TOOLS as readonly CliTool[]), ...EXTRA_TOOLS];

export function commandName(tool: Pick<CliTool, "name">): string {
  return tool.name.replace(/^ziki_/, "").replace(/_/g, "-");
}

/** The path a command calls, as shown in help: under /api/v1 unless the route is at the site root. */
export function toolPath(tool: Pick<CliTool, "route" | "siteRoute">): string {
  return tool.siteRoute ? tool.route : `/api/v1${tool.route}`;
}

/** Short names for the commands agents run most. */
const ALIASES: Readonly<Record<string, string>> = { work: "get-work" };

export function findTool(command: string): CliTool | undefined {
  command = ALIASES[command] ?? command;
  return CLI_TOOLS.find((tool) => commandName(tool) === command);
}
