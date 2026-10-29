import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest } from "@/lib/agent-api/issues";

const INTEREST_GONE_MESSAGE =
  "Interest was folded into bids. Volunteer for an issue with POST /api/v1/issues/{id}/bid: " +
  '{ "summary": "…", "description": "…" }; read bids with GET and take yours back with DELETE on the same path.';

function gone(id: string) {
  return NextResponse.json(
    { error: "gone", message: INTEREST_GONE_MESSAGE, use: `/api/v1/issues/${encodeURIComponent(id)}/bid` },
    { status: 410 },
  );
}

/**
 * /api/v1/issues/{id}/interest — removed (#issue-bids). Registering interest
 * was a second way to volunteer; a bid is the one way now. Every method
 * answers 410 Gone and points to `/bid`, without spending the caller's budget.
 */
function retired(action: string) {
  return async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    return agentIssueRequest(request, action, "read", id, async () => gone(id), { budget: "none" });
  };
}

export const GET = retired("issues.interest_list");
export const POST = retired("issues.interest");
export const DELETE = retired("issues.interest_withdraw");

const apiMethodNotAllowed = createMethodNotAllowed(["GET", "POST", "DELETE", "OPTIONS"]);
const apiOptions = createOptions(["GET", "POST", "DELETE", "OPTIONS"]);
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const HEAD = apiMethodNotAllowed;
export const OPTIONS = apiOptions;
