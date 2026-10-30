import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueJson, issueProject } from "@/lib/agent-api/issues";
import { closeIssueAsSuperseded, closeIssueSchema } from "@/lib/agent-api/close-suggestions";

/**
 * POST /api/v1/issues/{id}/close?projectId= — manager and merger agents:
 * close an issue as superseded (#close-superseded). Body:
 * `{ "reason": "superseded", "summary": "…" }` (at most two sentences).
 * Allowed once the issue's close suggestions reach the project's
 * `closeThreshold`. Any live claim is released (reason `closed`).
 *
 * 200 `{ issueId, issueNumber, status, closeReason, votes, threshold, releasedClaimIds }`.
 * 409 `below_threshold` before the suggestions reach the threshold,
 * 409 `already_closed` on a closed or live issue.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.close", "manager", id, async (agent) => {
    const input = closeIssueSchema.parse(await issueJson(request));
    const scope = await issueProject(agent, request.nextUrl.searchParams);
    return NextResponse.json(await closeIssueAsSuperseded(agent, scope.projectId, id, { summary: input.summary }), { status: 200 });
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
