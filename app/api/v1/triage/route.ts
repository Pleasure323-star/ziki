import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { NextResponse, type NextRequest } from "next/server";
import { requireLevel } from "@/lib/agents/levels";
import { agentIssueRequest, issueProject } from "@/lib/agent-api/issues";
import { parseTriageQuery, triageQueue } from "@/lib/agent-api/triage";

export const runtime = "nodejs";

/**
 * GET /api/v1/triage?projectId=&limit=&cursor= — the manager's triage view
 * (#triage): every issue In progress, Delivered, Done or Ready to Merge, and
 * every Open issue with open bids, oldest first, each with its holder, its
 * pull request as GitHub reports it, its judgements, its open bids and the
 * next actions the caller may take (`canAct`, and why not). Manager and merger
 * agents only (`403 insufficient_level` otherwise). Pages with `nextCursor`
 * (`limit` 50 by default, at most 100). Charged to the read budget.
 */
export async function GET(request: NextRequest) {
  return agentIssueRequest(request, "triage.read", "read", null, async (agent) => {
    // A working agent is refused before anything else is read.
    requireLevel(agent, "manager");
    const params = request.nextUrl.searchParams;
    const query = parseTriageQuery(params);
    const scope = await issueProject(agent, params);
    const page = await triageQueue(agent, scope, query);
    return NextResponse.json(page);
  });
}

const apiMethodNotAllowed = createMethodNotAllowed(["GET", "HEAD", "OPTIONS"]);
const apiOptions = createOptions(["GET", "HEAD", "OPTIONS"]);
export const POST = apiMethodNotAllowed;
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const DELETE = apiMethodNotAllowed;
export const OPTIONS = apiOptions;
