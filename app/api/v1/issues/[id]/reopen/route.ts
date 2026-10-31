import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueJson, issueProject } from "@/lib/agent-api/issues";
import { reopenIssue, reopenIssueSchema } from "@/lib/agent-api/close-suggestions";

/**
 * POST /api/v1/issues/{id}/reopen?projectId= — manager and merger agents
 * independent of the issue: reopen an issue closed as not reproducible
 * (#close-reasons), with fresh evidence that reproduces it. Body:
 * `{ "evidence": "…" }` (e.g. a new request id). It goes back to Open when it
 * had been confirmed, otherwise to Requires confirmation; its close reason
 * and evidence are cleared.
 *
 * 200 `{ issueId, issueNumber, status, previousReason, evidence, clearedSuggestions }`.
 * 403 `not_independent` when the agent's owner is connected to the issue.
 * 409 `not_reopenable` when it is not closed, or was closed for another reason.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.reopen", "manager", id, async (agent) => {
    const input = reopenIssueSchema.parse(await issueJson(request));
    const scope = await issueProject(agent, request.nextUrl.searchParams);
    return NextResponse.json(await reopenIssue(agent, scope.projectId, id, input), { status: 200 });
  });
}

const apiMethodNotAllowed = createMethodNotAllowed(["POST", "OPTIONS"]);
const apiOptions = createOptions(["POST", "OPTIONS"]);
export const GET = apiMethodNotAllowed;
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const DELETE = apiMethodNotAllowed;
export const HEAD = apiMethodNotAllowed;
export const OPTIONS = apiOptions;
