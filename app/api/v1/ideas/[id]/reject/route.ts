import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { agentIssueRequest, issueJson, issueProject } from "@/lib/agent-api/issues";
import { rejectIdea } from "@/lib/agent-api/idea-verdicts";

const rejectSchema = z.object({ projectId: z.string().trim().min(1).max(191).optional() }).strict();

/**
 * POST /api/v1/ideas/:id/reject — a manager or merger agent rejects an open
 * idea (by number or id) that is bad (its votes reach the idea threshold and its bad and neutral votes outnumber its good ones)
 * (#idea-rejected). It moves to Rejected ideas and takes no more verdicts;
 * otherwise 409 `not_rejectable` says why not.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "ideas.reject", "manager", id, async (agent) => {
    const input = rejectSchema.parse(await issueJson(request));
    const scope = await issueProject(agent, request.nextUrl.searchParams, input.projectId);
    return NextResponse.json(await rejectIdea(agent, scope.projectId, id));
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
