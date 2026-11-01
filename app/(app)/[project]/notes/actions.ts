"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth-helpers";
import { currentTenantIdFor } from "@/lib/tenant-context";
import { addNoteComment, humanNotesActor, saveProjectNotes, restoreProjectNotes, voteNoteComment } from "@/lib/project-notes";
import { IssueApiError } from "@/lib/agent-api/errors";
import { logger } from "@/lib/logger";

export type NotesActionResult = { error?: string; version?: number };
export async function saveNotesAction(projectId: string, input: unknown): Promise<NotesActionResult> {
  const user = await requireUser();
  try {
    const tenantId = await currentTenantIdFor(user.id);
    if (!tenantId) return { error: "Select a workspace first." };
    const actor = await humanNotesActor(user, tenantId, projectId);
    const result = await saveProjectNotes(actor, input);
    revalidatePath("/[project]/notes", "page");
    return { version: result.version };
  } catch (error) {
    if (error instanceof IssueApiError) return { error: error.message };
    if (error instanceof z.ZodError) return { error: "Enter notes and a change summary within the allowed limits." };
    logger.error("[project-notes] save failed", error);
    return { error: "Could not save notes. Your draft is still available; try again." };
  }
}

export async function restoreNotesAction(projectId: string, revisionId: string, input: unknown): Promise<NotesActionResult> {
  const user = await requireUser();
  try {
    const tenantId = await currentTenantIdFor(user.id);
    if (!tenantId) return { error: "Select a workspace first." };
    const actor = await humanNotesActor(user, tenantId, projectId);
    const result = await restoreProjectNotes(actor, revisionId, input);
    revalidatePath("/[project]/notes", "page");
    return { version: result.version };
  } catch (error) {
    if (error instanceof IssueApiError) return { error: error.message };
    if (error instanceof z.ZodError) return { error: "Enter a change summary before restoring." };
    logger.error("[project-notes] restore failed", error);
    return { error: "Could not restore this revision. Try again." };
  }
}

/** A member adds a note comment in the app (#732). The draft stays on the page when it fails. */
export async function addNoteCommentAction(projectId: string, body: string): Promise<{ error?: string; id?: string }> {
  const user = await requireUser();
  try {
    const tenantId = await currentTenantIdFor(user.id);
    if (!tenantId) return { error: "Select a workspace first." };
    const actor = await humanNotesActor(user, tenantId, projectId);
    const { comment } = await addNoteComment(actor, { body });
    revalidatePath("/[project]/notes", "page");
    return { id: comment.id };
  } catch (error) {
    if (error instanceof IssueApiError) return { error: error.message };
    if (error instanceof z.ZodError) return { error: "Write a note of up to 10,000 characters." };
    logger.error("[project-notes] comment failed", error);
    return { error: "Could not post the note. Your draft is still here; try again." };
  }
}

/** A member upvotes a note comment or takes it back (#732): one vote per person. */
export async function voteNoteCommentAction(projectId: string, commentId: string, upvote: boolean): Promise<{ error?: string; upvoted?: boolean; upvotes?: number }> {
  const user = await requireUser();
  try {
    const tenantId = await currentTenantIdFor(user.id);
    if (!tenantId) return { error: "Select a workspace first." };
    const actor = await humanNotesActor(user, tenantId, projectId);
    const result = await voteNoteComment(actor, commentId, upvote);
    revalidatePath("/[project]/notes", "page");
    return result;
  } catch (error) {
    if (error instanceof IssueApiError) return { error: error.message };
    logger.error("[project-notes] vote failed", error);
    return { error: "Could not record the vote. Try again." };
  }
}
