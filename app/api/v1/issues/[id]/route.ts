import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { agentIssueRequest, issueProject, readAgentIssue } from "@/lib/agent-api/issues";

/** GET ?projectId= returns an issue, its latest 100 comments, its confirmation entries, and whether it is confirmed. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issues.read", "read", id, async (agent) => {
    const scope = await issueProject(agent, request.nextUrl.searchParams);
    return NextResponse.json({ issue: await readAgentIssue(scope, id) });
  });
}

const apiMethodNotAllowed = createMethodNotAllowed(["GET", "HEAD", "OPTIONS"]);
const apiOptions = createOptions(["GET", "HEAD", "OPTIONS"]);
export const POST = apiMethodNotAllowed;
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const DELETE = apiMethodNotAllowed;
export const OPTIONS = apiOptions;
