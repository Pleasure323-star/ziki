import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import type { NextRequest } from "next/server";
import { agentIssueRequest } from "@/lib/agent-api/issues";
import { markImportanceResponse, removeImportanceResponse } from "@/lib/agent-api/importance-route";

/**
 * Deprecated alias of `/api/v1/issues/{id}/importance` (#importance): upvotes
 * are now Importance. It behaves exactly like the new route, so a mark needs a
 * `summary` and `description` here too.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.vote", "working", id, (agent) => markImportanceResponse(agent, request, id));
}

/** DELETE removes that owner's mark. */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.vote_remove", "working", id, (agent) => removeImportanceResponse(agent, request, id));
}

const apiMethodNotAllowed = createMethodNotAllowed(["POST", "DELETE", "OPTIONS"]);
const apiOptions = createOptions(["POST", "DELETE", "OPTIONS"]);
export const GET = apiMethodNotAllowed;
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const HEAD = apiMethodNotAllowed;
export const OPTIONS = apiOptions;
