import type { NextRequest } from "next/server";
import { notesRequest, type NotesRouteContext } from "@/lib/agent-api/notes";
import { addAgentNote, listAgentNotes } from "@/lib/agent-notes";
import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { issueJson } from "@/lib/agent-api/issues";

export const runtime = "nodejs";

/** The calling agent's own notes on the project (#agent-notes), newest first. */
export async function GET(request: NextRequest, context: NotesRouteContext) {
  return notesRequest(request, context, "notes.mine", false, (actor) => listAgentNotes(actor));
}
/** Keep a note for yourself: `{ body }`. */
export async function POST(request: NextRequest, context: NotesRouteContext) {
  return notesRequest(request, context, "notes.mine.add", true, async (actor) => addAgentNote(actor, await issueJson(request)), 201);
}

const apiMethodNotAllowed = createMethodNotAllowed(["GET", "POST", "HEAD", "OPTIONS"]);
export const PUT = apiMethodNotAllowed;
export const PATCH = apiMethodNotAllowed;
export const DELETE = apiMethodNotAllowed;
export const OPTIONS = createOptions(["GET", "POST", "HEAD", "OPTIONS"]);
