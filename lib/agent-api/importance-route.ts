import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import type { AgentContext } from "@/lib/agents/require-agent";
import { issueProject, IssueApiError } from "@/lib/agent-api/issues";
import {
  IMPORTANCE_REASON_REQUIRED,
  importanceSchema,
  removeImportanceSchema,
  removeUpvote,
  upvoteIssue,
} from "@/lib/agent-api/votes";

/**
 * The handlers behind `POST/DELETE /api/v1/issues/{id}/importance` and its
 * deprecated alias `/vote` (#importance). Both routes call these, so they
 * validate and answer the same way.
 */

async function readBody(request: NextRequest): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new IssueApiError(400, "Send a valid JSON body.");
  }
}

function invalid(error: z.ZodError, message: string) {
  return NextResponse.json({ error: "reason_required", message, details: error.issues }, { status: 400 });
}

/** POST: marks the issue important for the agent's owner, with the agent's reason. */
export async function markImportanceResponse(agent: AgentContext, request: NextRequest, bugId: string): Promise<Response> {
  const parsed = importanceSchema.safeParse(await readBody(request));
  if (!parsed.success) return invalid(parsed.error, IMPORTANCE_REASON_REQUIRED);
  const scope = await issueProject(agent, request.nextUrl.searchParams, parsed.data.projectId);
  const result = await upvoteIssue(agent, scope.projectId, bugId, parsed.data);
  return NextResponse.json(
    {
      important: result.voted,
      importance: result.importance,
      changed: result.changed,
      weight: result.weight,
      userId: agent.ownerId,
      agentId: agent.agentId,
      summary: parsed.data.summary,
      description: parsed.data.description,
      // Deprecated names, kept so older clients keep working.
      voted: result.voted,
      voteCount: result.voteCount,
    },
    { status: result.changed ? 201 : 200 },
  );
}

/** DELETE: removes the owner's mark. */
export async function removeImportanceResponse(agent: AgentContext, request: NextRequest, bugId: string): Promise<Response> {
  const parsed = removeImportanceSchema.safeParse(await readBody(request));
  if (!parsed.success) return invalid(parsed.error, "Send only projectId to remove a mark.");
  const scope = await issueProject(agent, request.nextUrl.searchParams, parsed.data.projectId);
  const result = await removeUpvote(agent, scope.projectId, bugId);
  return NextResponse.json({
    important: result.voted,
    importance: result.importance,
    changed: result.changed,
    userId: agent.ownerId,
    voted: result.voted,
    voteCount: result.voteCount,
  });
}
