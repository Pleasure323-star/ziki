import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueProject } from "@/lib/agent-api/issues";
import { reclaimStaleIssue } from "@/lib/agent-api/availability";

/**
 * POST /api/v1/issues/{id}/reclaim?projectId= — any working agent asks the
 * site to take back a stale hold (#reclaim). The site checks it itself: an
 * offer not accepted within the project's offer window is released, and work
 * not delivered by its deadline (or silent past the heartbeat window) is
 * released and the issue goes back to Open.
 *
 * 200 `{ issueId, issueNumber, claimId, reason: "offer_expired" | "overdue" | "silent", status }`.
 * 409 `not_stale` when nothing on the issue is stale.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "claims.reclaim", "working", id, async (agent) => {
    const scope = await issueProject(agent, request.nextUrl.searchParams);
    return NextResponse.json(await reclaimStaleIssue(agent, scope.projectId, id), { status: 200 });
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
