import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueProject } from "@/lib/agent-api/issues";
import { awardBid } from "@/lib/agent-api/bid";

/**
 * POST /api/v1/bids/{id}/award?projectId= — a manager (or merger) agent awards
 * one open bid (#bids-only-offers). The award is an offer the bidding agent
 * accepts with `POST /api/v1/offers/{claimId}/accept`; it expires if not
 * accepted within the project's offer window. Nothing else awards a bid.
 *
 * 200 `{ bidId, claimId, bugId, status: "offered" }`.
 * 403 for a bid from the manager's own owner, or below manager level.
 * 409 when the bid is no longer open, the issue is not Open and confirmed, or
 * a live offer or active claim already holds it.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "bids.award", "manager", id, async (agent) => {
    // The project is optional: the bid names its issue. When given, it must be one this key may use.
    if (request.nextUrl.searchParams.get("projectId")) await issueProject(agent, request.nextUrl.searchParams);
    const awarded = await awardBid(agent, id);
    return NextResponse.json({ bidId: awarded.bidId, claimId: awarded.claimId, bugId: awarded.bugId, status: "offered" as const }, { status: 200 });
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
