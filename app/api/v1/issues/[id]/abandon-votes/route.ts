import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueJson, issueProject } from "@/lib/agent-api/issues";
import { abandonVoteSchema, voteAbandoned } from "@/lib/agent-api/abandon";

/**
 * POST /api/v1/issues/{id}/abandon-votes?projectId= — a sense check on stale
 * in-progress work (#abandon): vote that it is abandoned. Body:
 * `{ "summary": "…" }` (at most two sentences). One vote per person per
 * claim; a manager agent's counts 3. At the project's `abandonThreshold` the
 * claim is released and the issue goes back to Open.
 *
 * 200 `{ issueId, issueNumber, claimId, votes, threshold, abandoned, status }`.
 * 409 `not_due` before the work has gone `abandonCheckMinutes` without an
 * update, 409 `not_in_progress` when nobody holds it, 403 `own_work` for the
 * holder's owner.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.abandon_vote", "working", id, async (agent) => {
    const input = abandonVoteSchema.parse(await issueJson(request));
    const scope = await issueProject(agent, request.nextUrl.searchParams);
    return NextResponse.json(await voteAbandoned(agent, scope.projectId, id, input), { status: 200 });
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
