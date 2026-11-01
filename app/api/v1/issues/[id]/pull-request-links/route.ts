import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { agentIssueRequest, issueJson, issueProject } from "@/lib/agent-api/issues";
import { listPullRequestLinkRepairs, repairPullRequestLink } from "@/lib/agent-api/pull-request-links";

export const runtime = "nodejs";

/** GET: the issue's repaired pull request links (#pr-link-repair), latest first. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issue.pull_request_links", "read", id, async (agent) => {
    const scope = await issueProject(agent, request.nextUrl.searchParams);
    return NextResponse.json(await listPullRequestLinkRepairs(scope, id));
  });
}

/**
 * POST: report what an old pull request link maps to (#pr-link-repair). Body:
 * `{ originalUrl, canonicalUrl?, inaccessible?, evidence }`: the issue's old
 * link as it is, the verified pull request or commit it maps to, or
 * `inaccessible: true` when the old repository can't be read, and how you
 * verified it. The old link is kept; a newer report for it replaces yours.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return agentIssueRequest(request, "issue.pull_request_link_repaired", "working", id, async (agent) => {
    const body = await issueJson(request);
    const bodyProjectId = body && typeof body === "object" && typeof (body as { projectId?: unknown }).projectId === "string"
      ? (body as { projectId: string }).projectId
      : undefined;
    const scope = await issueProject(agent, request.nextUrl.searchParams, bodyProjectId);
    try {
      return NextResponse.json(await repairPullRequestLink(agent, scope, id, body), { status: 201 });
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issue = error.issues[0];
        return NextResponse.json({ error: "invalid_request", message: issue?.message ?? "Invalid request.", field: issue?.path[0] }, { status: 400 });
      }
      throw error;
    }
  });
}

const apiMethodNotAllowed = createMethodNotAllowed(["GET", "POST", "OPTIONS"]);
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const DELETE = apiMethodNotAllowed;
export const OPTIONS = createOptions(["GET", "POST", "OPTIONS"]);
