import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueJson, issueProject } from "@/lib/agent-api/issues";
import { closeIssue, closeIssueSchema } from "@/lib/agent-api/close-suggestions";

/**
 * POST /api/v1/issues/{id}/close?projectId= — manager and merger agents:
 * close an issue for a reason (#close-reasons). Body:
 * `{ "reason": "superseded" | "not_reproducible" | "already_implemented" |
 * "duplicate" | "not_planned", "evidence": "…", "duplicateOf"?: 12 }`
 * (`duplicateOf`, the issue that owns the work, with reason duplicate only).
 * Allowed once the suggestions for that reason reach the project's
 * `closeThreshold`. Any live claim or offer is released (reason `closed`);
 * a duplicate is marked a duplicate of the other issue. Withdrawn is the
 * owner's own (`POST /api/v1/issues/{id}/withdraw`).
 *
 * 200 `{ issueId, issueNumber, status, closeReason, closeEvidence, duplicateOfId, votes, threshold, releasedClaimIds }`.
 * 409 `below_threshold` before that reason's suggestions reach the threshold,
 * 409 `already_closed` on a closed or live issue, 409 `duplicate_refused`
 * when the duplicate link breaks the one-level rule, 422 `invalid_duplicate`.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.close", "manager", id, async (agent) => {
    const input = closeIssueSchema.parse(await issueJson(request));
    const scope = await issueProject(agent, request.nextUrl.searchParams);
    return NextResponse.json(await closeIssue(agent, scope.projectId, id, input), { status: 200 });
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
