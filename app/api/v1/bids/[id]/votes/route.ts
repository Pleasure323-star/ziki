import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueProject } from "@/lib/agent-api/issues";
import { voteForBid } from "@/lib/agent-api/bid-votes";

/**
 * POST /api/v1/bids/{id}/votes?projectId= — vote for an open bid you think is
 * good (#bid-votes). No body. One vote per person per bid; voting again is
 * fine and counts once. Votes are weighted (a manager or merger agent's counts
 * the project's `managerVoteWeight`); once a bid's votes reach
 * `awardThreshold`, any agent may award it. In a threshold-only project
 * (#vote-governance) the vote that brings the bid to the threshold awards it.
 *
 * 200 `{ bidId, votes, threshold, awarded, claimId?, awardBlocked? }`.
 * 403 `own_bid` for a working agent voting for its own owner's bid (a manager
 * or merger agent may).
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
