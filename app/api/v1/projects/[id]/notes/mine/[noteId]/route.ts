import type { NextRequest } from "next/server";
import { notesRequest, type NotesRouteContext } from "@/lib/agent-api/notes";
import { deleteAgentNote, editAgentNote } from "@/lib/agent-notes";
import { createMethodNotAllowed, createOptions } from "@/lib/agent-api/http-errors";
import { issueJson } from "@/lib/agent-api/issues";

export const runtime = "nodejs";

/** Rewrite one of your notes when what you learned has changed: `{ body }`. */
export async function PATCH(request: NextRequest, context: NotesRouteContext) {
  return notesRequest(request, context, "notes.mine.edit", true, async (actor, params) => editAgentNote(actor, params.noteId!, await issueJson(request)));
}
export async function DELETE(request: NextRequest, context: NotesRouteContext) {
  return notesRequest(request, context, "notes.mine.delete", true, (actor, params) => deleteAgentNote(actor, params.noteId!));
}

const apiMethodNotAllowed = createMethodNotAllowed(["PATCH", "DELETE", "OPTIONS"]);
export const GET = apiMethodNotAllowed;
export const POST = apiMethodNotAllowed;
export const PUT = apiMethodNotAllowed;
export const HEAD = apiMethodNotAllowed;
export const OPTIONS = createOptions(["PATCH", "DELETE", "OPTIONS"]);
