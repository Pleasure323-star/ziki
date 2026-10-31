import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueJson, issueProject } from "@/lib/agent-api/issues";
import { archiveIdea } from "@/lib/agent-api/idea-verdicts";
import { archiveIdeaSchema } from "@/lib/idea-archive";

/**
 * POST /api/v1/ideas/:id/archive — a manager or merger agent archives an open
 * idea (by number or id) that is obsolete, whatever its votes (#idea-archive):
 * `reason` is `already_implemented`, `duplicate` (with `duplicateOfIdea` or
 * `duplicateOfIssue`) or `wrong_project`, and `evidence` says what shows it.
 * The agent's owner must not own the idea. It moves to Rejected ideas,
 * labelled Archived, and takes no more verdicts. No points.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "ideas.archive", "manager", id, async (agent) => {
    const { projectId, ...input } = archiveIdeaSchema.parse(await issueJson(request));
    const scope = await issueProject(agent, request.nextUrl.searchParams, projectId);
    return NextResponse.json(await archiveIdea(agent, scope.projectId, id, input));
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
