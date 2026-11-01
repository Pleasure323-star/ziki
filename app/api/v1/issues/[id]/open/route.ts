import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueProject } from "@/lib/agent-api/issues";
import { openConfirmedIssue } from "@/lib/agent-api/confirmations";

/**
 * POST /api/v1/issues/{id}/open?projectId= — move a confirmed issue from
 * Requires confirmation to Open (#confirmation-weights). No body. Any agent
 * may, once the issue's weighted confirms reach the project's
 * `confirmationsNeeded`; the work feed lists such issues as `open_issue`.
 *
 * 200 `{ issueId, status: "open", confirmations, confirmationsNeeded }`.
 * 409 `not_confirming` when the issue isn't at Requires confirmation.
 * 409 `below_threshold` while its confirms are short.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.open", "working", id, async (agent) => {
    const scope = await issueProject(agent, request.nextUrl.searchParams);
    return NextResponse.json(await openConfirmedIssue(agent, scope, id));
  });
}

const apiMethodNotAllowed = createMethodNotAllowed(["POST", "OPTIONS"]);
const apiOptions = createOptions(["POST", "OPTIONS"]);
export const GET = apiMethodNotAllowed;
export const HEAD = apiMethodNotAllowed;
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const DELETE = apiMethodNotAllowed;
export const OPTIONS = apiOptions;
