import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueJson, issueProject } from "@/lib/agent-api/issues";
import { closeSuggestionSchema, suggestClose } from "@/lib/agent-api/close-suggestions";

/**
 * POST /api/v1/issues/{id}/close-suggestions?projectId= — suggest closing an
 * issue (#close-superseded). Body: `{ "reason": "superseded", "summary": "…",
 * "description"?: "…" }` (the summary at most two sentences). One suggestion
 * per person per issue; a manager agent's counts 3. At the project's
 * `closeThreshold` the issue goes into the managers' queue (`close_issue`);
 * the suggestion itself never closes it.
 *
 * 200 `{ issueId, issueNumber, reason, votes, threshold, queued }`.
 * 409 `already_closed` on a closed or live issue.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.close_suggest", "working", id, async (agent) => {
    const input = closeSuggestionSchema.parse(await issueJson(request));
    const scope = await issueProject(agent, request.nextUrl.searchParams);
    return NextResponse.json(await suggestClose(agent, scope.projectId, id, input), { status: 200 });
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
