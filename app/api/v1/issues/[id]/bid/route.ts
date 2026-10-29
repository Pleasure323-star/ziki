import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueJson, issueProject, IssueApiError } from "@/lib/agent-api/issues";
import { listBids, parseBid, placeBid, withdrawBid } from "@/lib/agent-api/bid";

/** GET ?projectId= — the open bids on the issue, each with its summary, description and replies. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.bids", "read", id, async (agent) => {
    const scope = await issueProject(agent, request.nextUrl.searchParams);
    const bids = await listBids(agent, scope.projectId, id);
    return NextResponse.json({
      bids: bids.map((bid) => ({
        id: bid.id,
        agent_id: bid.agentId,
        agent_name: bid.agentName,
        beneficiary_user_id: bid.beneficiaryUserId,
        beneficiary_name: bid.by,
        area_match: bid.areaMatch,
        summary: bid.summary,
        description: bid.description,
        created_at: bid.createdAt.toISOString(),
        updated_at: bid.updatedAt.toISOString(),
        replies: bid.replies.map((reply) => ({
          id: reply.id,
          body: reply.body,
          author_id: reply.authorId,
          author_name: reply.authorName,
          agent_id: reply.agentId,
          agent_name: reply.agentName,
          created_at: reply.createdAt.toISOString(),
        })),
      })),
    });
  });
}

/**
 * POST — this agent's bid on an open, confirmed issue (#issue-bids):
 *
 *   { "summary": "…",      // required, at most two sentences
 *     "description": "…",  // required, how and why, in full
 *     "projectId": "…" }
 *
 * Placing it again replaces the agent's open bid (200; 201 for a new one).
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.bid", "working", id, async (agent) => {
    const input = parseBid(await issueJson(request));
    if (!request.nextUrl.searchParams.get("projectId") && !input.projectId) {
      return NextResponse.json({ error: "projectId is required." }, { status: 400 });
    }
    const scope = await issueProject(agent, request.nextUrl.searchParams, input.projectId);
    try {
      const { bid, replaced } = await placeBid(agent, scope.projectId, id, input);
      return NextResponse.json({
        bid_id: bid.id,
        status: "open",
        replaced,
        issue_id: bid.bugId,
        beneficiary_user_id: bid.beneficiaryUserId,
        summary: bid.summary,
        description: bid.description,
      }, { status: replaced ? 200 : 201 });
    } catch (error) {
      if (error instanceof IssueApiError) throw error;
      return NextResponse.json({ error: "Bid unavailable; try again." }, { status: 503 });
    }
  });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.bid_withdraw", "working", id, async (agent) => {
    const scope = await issueProject(agent, request.nextUrl.searchParams);
    const bid = await withdrawBid(agent, scope.projectId, id);
    return NextResponse.json({ bid_id: bid.id, status: "withdrawn" });
  });
}

const apiMethodNotAllowed = createMethodNotAllowed(["GET", "HEAD", "POST", "DELETE", "OPTIONS"]);
const apiOptions = createOptions(["GET", "HEAD", "POST", "DELETE", "OPTIONS"]);
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const OPTIONS = apiOptions;
