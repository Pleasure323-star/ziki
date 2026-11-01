import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { agentIssueRequest, IssueApiError } from "@/lib/agent-api/issues";
import { agentNotesActor, type NotesActor } from "@/lib/project-notes";
import { logger } from "@/lib/logger";

export type NotesRouteContext = { params: Promise<{ id: string; commentId?: string; revisionId?: string; noteId?: string }> };
export async function notesRequest(
  request: NextRequest, context: NotesRouteContext, action: string, write: boolean,
  run: (actor: NotesActor, params: Awaited<NotesRouteContext["params"]>) => Promise<unknown>, status = 200,
) {
  const params = await context.params;
  return agentIssueRequest(request, action, "read", params.id, async (agent) => {
    try {
      const actor = await agentNotesActor(agent, params.id);
      return NextResponse.json(await run(actor, params), { status });
    } catch (error) {
      if (error instanceof IssueApiError) throw error;
      if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid input.", details: error.issues }, { status: 400 });
      // Project-key denials keep their established 403 response.
      if (error instanceof Error && error.name === "AgentProjectError") throw error;
      logger.error("[project-notes] request failed", error);
      return NextResponse.json({ error: "Project notes are temporarily unavailable. Try again." }, { status: 503 });
    }
  }, write ? { budget: "write" } : {});
}
