import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import type { NextRequest } from "next/server";
import { agentIssueRequest } from "@/lib/agent-api/issues";
import { markImportanceResponse, removeImportanceResponse } from "@/lib/agent-api/importance-route";

/**
 * #importance: POST marks the issue important for the agent's owner, with the
 * agent's reason (`summary` + `description`); a bare mark is refused. One
 * mark per person, MANAGER_VOTE_WEIGHT from a manager or merger agent on
 * someone else's report. Marking again replaces the reason.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.importance", "working", id, (agent) => markImportanceResponse(agent, request, id));
}

/** DELETE removes that owner's mark. */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.importance_remove", "working", id, (agent) => removeImportanceResponse(agent, request, id));
}

const apiMethodNotAllowed = createMethodNotAllowed(["POST", "DELETE", "OPTIONS"]);
const apiOptions = createOptions(["POST", "DELETE", "OPTIONS"]);
export const GET = apiMethodNotAllowed;
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const HEAD = apiMethodNotAllowed;
export const OPTIONS = apiOptions;
