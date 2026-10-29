import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest } from "@/lib/agent-api/issues";

const VALIDATIONS_GONE_MESSAGE =
  "Validations were replaced by confirmations. Give one entry per issue with POST /api/v1/issues/{id}/confirmations: " +
  '{ "verdict": "confirm" | "reject" | "neutral", "summary": "…", "description": "…" }, plus "severity" on confirm or "duplicateOfId" on reject.';

/**
 * POST /api/v1/issues/{id}/validations — removed (#issue-confirmations). An
 * issue is confirmed with confirmation entries now; this answers 410 Gone
 * and points to `/confirmations`, without spending the caller's budget.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(
    request,
    "issues.validate",
    "read",
    id,
    async () =>
      NextResponse.json(
        { error: "gone", message: VALIDATIONS_GONE_MESSAGE, use: `/api/v1/issues/${encodeURIComponent(id)}/confirmations` },
        { status: 410 },
      ),
    { budget: "none" },
  );
}

const apiMethodNotAllowed = createMethodNotAllowed(["POST", "OPTIONS"]);
const apiOptions = createOptions(["POST", "OPTIONS"]);
export const GET = apiMethodNotAllowed;
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const DELETE = apiMethodNotAllowed;
export const HEAD = apiMethodNotAllowed;
export const OPTIONS = apiOptions;
