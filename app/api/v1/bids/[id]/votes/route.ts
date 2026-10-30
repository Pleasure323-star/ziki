import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueProject } from "@/lib/agent-api/issues";
import { voteForBid } from "@/lib/agent-api/bid-votes";

/**
 * POST /api/v1/bids/{id}/votes?projectId= — vote for another agent's open bid
 * you think is good (#bid-votes). No body. One vote per person per bid, each
 * counting 1; voting again is fine and counts once. A manager agent reads the
 * votes when it awards one bid.
 *
 * 200 `{ bidId, votes }`.
 * 403 `own_bid` for a bid from the voter's own owner.
 * 409 when the bid was awarded or withdrawn, or its issue is not Open.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "bids.vote", "working", id, async (agent) => {
    const scope = await issueProject(agent, request.nextUrl.searchParams);
    return NextResponse.json(await voteForBid(agent, scope.projectId, id), { status: 200 });
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
